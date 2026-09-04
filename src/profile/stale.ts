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
 * 3. Configured model(s) missing, unavailable, or unknown on current host
 * 4. Configured discrete effort value(s) no longer supported by current host
 * 5. Capability regression (e.g. subagents/threads marked available in profile but unavailable or unknown on host,
 *    or multi-model configured while host model_selection is unavailable or unknown)
 *
 * Fail closed: 'unknown' capability state is not safely confirmed and fails closed as stale/needs-repair.
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

  // 3. Configured models missing or unavailable or unknown on host
  if (currentHost.available_models && currentHost.available_models.length > 0) {
    const availableModelIds = new Set(
      currentHost.available_models
        .filter((m) => m.state === "available")
        .map((m) => m.id)
    );

    const unknownOrUnavailableModelIds = new Set(
      currentHost.available_models
        .filter((m) => m.state !== "available")
        .map((m) => m.id)
    );

    if (profile.model_mode === "single" && profile.single_model) {
      const mId = profile.single_model.model;
      if (unknownOrUnavailableModelIds.has(mId)) {
        reasons.push(
          `Configured single model '${mId}' is no longer available on host '${currentHost.host_id}'`
        );
      } else if (!availableModelIds.has(mId)) {
        reasons.push(
          `Configured single model '${mId}' is no longer available on host '${currentHost.host_id}'`
        );
      }
    } else if (profile.model_mode === "multi" && profile.tiers) {
      const tierNames = ["routine", "standard", "high", "review"] as const;
      for (const tier of tierNames) {
        const mapping = profile.tiers[tier];
        if (mapping) {
          if (unknownOrUnavailableModelIds.has(mapping.model)) {
            reasons.push(
              `Configured model '${mapping.model}' for tier '${tier}' is no longer available on host '${currentHost.host_id}'`
            );
          } else if (!availableModelIds.has(mapping.model)) {
            reasons.push(
              `Configured model '${mapping.model}' for tier '${tier}' is no longer available on host '${currentHost.host_id}'`
            );
          }
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

  // 5. Capability regressions (unavailable or unknown fail closed)
  if (profile.capabilities && currentHost.capabilities) {
    if (profile.capabilities.subagents === "available") {
      const hostSubagentState = currentHost.capabilities.subagents?.state;
      if (hostSubagentState === "unavailable") {
        reasons.push(
          "Subagent capability was marked available in profile but is now unavailable on current host"
        );
      } else if (hostSubagentState === "unknown") {
        reasons.push(
          "Subagent capability was marked available in profile but is now unknown on current host"
        );
      }
    }

    if (profile.capabilities.threads === "available") {
      const hostThreadState = currentHost.capabilities.threads?.state;
      if (hostThreadState === "unavailable") {
        reasons.push(
          "Thread capability was marked available in profile but is now unavailable on current host"
        );
      } else if (hostThreadState === "unknown") {
        reasons.push(
          "Thread capability was marked available in profile but is now unknown on current host"
        );
      }
    }

    if (profile.capabilities.parallelism === "available") {
      const hostParallelState = currentHost.capabilities.parallelism?.state;
      if (hostParallelState === "unavailable") {
        reasons.push(
          "Parallelism capability was marked available in profile but is now unavailable on current host"
        );
      } else if (hostParallelState === "unknown") {
        reasons.push(
          "Parallelism capability was marked available in profile but is now unknown on current host"
        );
      }
    }
  }

  // Multi-model support regression
  if (profile.model_mode === "multi") {
    const hostModelSelState = currentHost.capabilities?.model_selection?.state;
    if (hostModelSelState === "unavailable") {
      reasons.push(
        "Profile requires multi-model mode, but host model selection capability is unavailable"
      );
    } else if (hostModelSelState === "unknown") {
      reasons.push(
        "Profile requires multi-model mode, but host model selection capability is unknown"
      );
    }
  }

  return {
    stale: reasons.length > 0,
    reasons,
  };
}
