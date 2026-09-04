import { Profile } from "./schema.js";
import { HostCapabilities } from "../adapters/contract.js";

export interface StaleCheckResult {
  stale: boolean;
  reasons: string[];
}

/**
 * Checks whether a stored profile is stale compared against current host capabilities.
 *
 * Conflict criteria:
 * 1. Adapter mismatch (profile.host.adapter !== currentHost.adapter_id)
 * 2. Host ID mismatch (profile.host.id !== currentHost.host_id)
 * 3. Configured model(s) missing or unavailable on current host
 * 4. Configured discrete effort value(s) no longer supported by current host
 * 5. Capability regression (e.g. subagents/threads marked available in profile but unavailable on host,
 *    or multi-model configured while host model_selection is unavailable)
 *
 * Strictly NO time-based expiry: a profile remains valid indefinitely as long as models
 * and host capabilities remain compatible.
 */
export function checkProfileStale(
  profile: Profile,
  currentHost: HostCapabilities
): StaleCheckResult {
  const reasons: string[] = [];

  // 1. Adapter ID mismatch
  if (profile.host.adapter !== currentHost.adapter_id) {
    reasons.push(
      `Adapter mismatch: profile expects adapter '${profile.host.adapter}' but current host uses '${currentHost.adapter_id}'`
    );
  }

  // 2. Host ID mismatch
  if (profile.host.id !== currentHost.host_id) {
    reasons.push(
      `Host ID mismatch: profile configured for '${profile.host.id}' but current host is '${currentHost.host_id}'`
    );
  }

  // 3. Configured models missing or unavailable on host
  if (currentHost.available_models && currentHost.available_models.length > 0) {
    const availableModelIds = new Set(
      currentHost.available_models
        .filter((m) => m.state === "available")
        .map((m) => m.id)
    );

    if (profile.model_mode === "single" && profile.single_model) {
      if (!availableModelIds.has(profile.single_model.model)) {
        reasons.push(
          `Configured single model '${profile.single_model.model}' is no longer available on host '${currentHost.host_id}'`
        );
      }
    } else if (profile.model_mode === "multi" && profile.tiers) {
      const tierNames = ["routine", "standard", "high", "review"] as const;
      for (const tier of tierNames) {
        const mapping = profile.tiers[tier];
        if (mapping && !availableModelIds.has(mapping.model)) {
          reasons.push(
            `Configured model '${mapping.model}' for tier '${tier}' is no longer available on host '${currentHost.host_id}'`
          );
        }
      }
    }
  }

  // 4. Configured effort values no longer supported
  if (
    currentHost.supported_effort_values &&
    currentHost.supported_effort_values.length > 0
  ) {
    const supportedSet = new Set(currentHost.supported_effort_values);

    const checkEffort = (
      effort: { policy?: string; value?: string } | undefined,
      context: string
    ) => {
      if (effort && "value" in effort && effort.value) {
        if (!supportedSet.has(effort.value)) {
          reasons.push(
            `Configured effort value '${effort.value}' for ${context} is no longer supported by host (supported: ${currentHost.supported_effort_values.join(", ")})`
          );
        }
      }
    };

    if (profile.model_mode === "single" && profile.single_model) {
      checkEffort(
        profile.single_model.execution_effort,
        "single-model execution effort"
      );
      checkEffort(
        profile.single_model.review_effort,
        "single-model review effort"
      );
    } else if (profile.model_mode === "multi" && profile.tiers) {
      const tierNames = ["routine", "standard", "high", "review"] as const;
      for (const tier of tierNames) {
        checkEffort(profile.tiers[tier]?.effort, `tier '${tier}'`);
      }
    }
  }

  // 5. Capability regressions
  if (profile.capabilities && currentHost.capabilities) {
    if (
      profile.capabilities.subagents === "available" &&
      currentHost.capabilities.subagents?.state === "unavailable"
    ) {
      reasons.push(
        "Subagent capability was marked available in profile but is now unavailable on current host"
      );
    }

    if (
      profile.capabilities.threads === "available" &&
      currentHost.capabilities.threads?.state === "unavailable"
    ) {
      reasons.push(
        "Thread capability was marked available in profile but is now unavailable on current host"
      );
    }

    if (
      profile.capabilities.parallelism === "available" &&
      currentHost.capabilities.parallelism?.state === "unavailable"
    ) {
      reasons.push(
        "Parallelism capability was marked available in profile but is now unavailable on current host"
      );
    }
  }

  // Multi-model support regression
  if (
    profile.model_mode === "multi" &&
    currentHost.capabilities?.model_selection?.state === "unavailable"
  ) {
    reasons.push(
      "Profile requires multi-model mode, but host model selection capability is unavailable"
    );
  }

  return {
    stale: reasons.length > 0,
    reasons,
  };
}
