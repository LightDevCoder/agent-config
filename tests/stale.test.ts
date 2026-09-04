import { describe, it, expect } from "vitest";
import { checkProfileStale } from "../src/profile/stale.js";
import { Profile } from "../src/profile/schema.js";
import { HostCapabilities } from "../src/adapters/contract.js";

describe("Stale Detection (Genuine Conflicts Only, NO Time-Based Expiry)", () => {
  const baseHostCapabilities: HostCapabilities = {
    host_id: "codex",
    adapter_id: "codex-adapter",
    workspace: "/workspaces/my-app",
    observed_at: "2026-09-04T12:00:00Z",
    available_models: [
      { id: "gpt-4o-mini", state: "available" },
      { id: "gpt-4o", state: "available" },
      { id: "o3-mini", state: "available" },
    ],
    supported_effort_values: ["low", "medium", "high"],
    capabilities: {
      subagents: { state: "available" },
      threads: { state: "available" },
      parallelism: { state: "available" },
      model_selection: { state: "available" },
    },
  };

  const validSingleProfile: Profile = {
    profile_version: 1,
    host: {
      id: "codex",
      adapter: "codex-adapter",
    },
    scope: {
      type: "project",
      workspace: "/workspaces/my-app",
    },
    model_mode: "single",
    single_model: {
      model: "o3-mini",
      execution_effort: { policy: "highest-supported" },
    },
    capabilities: {
      subagents: "available",
      threads: "available",
      parallelism: "available",
    },
    created_at: "2024-01-01T00:00:00Z", // Created long ago
    updated_at: "2024-01-01T00:00:00Z",
  };

  const validMultiProfile: Profile = {
    profile_version: 1,
    host: {
      id: "codex",
      adapter: "codex-adapter",
    },
    scope: {
      type: "project",
      workspace: "/workspaces/my-app",
    },
    model_mode: "multi",
    tiers: {
      routine: {
        model: "gpt-4o-mini",
        effort: { value: "low" },
        source: "user-confirmed",
      },
      standard: {
        model: "gpt-4o",
        effort: { value: "medium" },
        source: "user-confirmed",
      },
      high: {
        model: "o3-mini",
        effort: { value: "high" },
        source: "user-confirmed",
      },
      review: {
        model: "o3-mini",
        effort: { policy: "highest-supported" },
        source: "user-confirmed",
      },
    },
    capabilities: {
      subagents: "available",
      threads: "available",
      parallelism: "available",
    },
    created_at: "2023-05-15T00:00:00Z",
    updated_at: "2023-05-15T00:00:00Z",
  };

  it("should NOT be stale when models and capabilities match, regardless of how old the profile is", () => {
    // Both profiles are from 2023 / 2024, yet current models/capabilities are identical
    const resultSingle = checkProfileStale(validSingleProfile, baseHostCapabilities);
    expect(resultSingle.stale).toBe(false);
    expect(resultSingle.reasons).toHaveLength(0);

    const resultMulti = checkProfileStale(validMultiProfile, baseHostCapabilities);
    expect(resultMulti.stale).toBe(false);
    expect(resultMulti.reasons).toHaveLength(0);
  });

  describe("Genuine Conflicts", () => {
    it("should mark stale when adapter ID does not match", () => {
      const conflictCapabilities: HostCapabilities = {
        ...baseHostCapabilities,
        adapter_id: "opencode-adapter", // Mismatch
      };

      const result = checkProfileStale(validSingleProfile, conflictCapabilities);
      expect(result.stale).toBe(true);
      expect(result.reasons.some((r) => r.includes("Adapter mismatch"))).toBe(true);
    });

    it("should mark stale when host ID does not match", () => {
      const conflictCapabilities: HostCapabilities = {
        ...baseHostCapabilities,
        host_id: "different-host", // Mismatch
      };

      const result = checkProfileStale(validSingleProfile, conflictCapabilities);
      expect(result.stale).toBe(true);
      expect(result.reasons.some((r) => r.includes("Host ID mismatch"))).toBe(true);
    });

    it("should mark stale when single-model configured model is no longer available", () => {
      const hostWithoutModel: HostCapabilities = {
        ...baseHostCapabilities,
        available_models: [
          { id: "gpt-4o", state: "available" },
          // "o3-mini" is gone!
        ],
      };

      const result = checkProfileStale(validSingleProfile, hostWithoutModel);
      expect(result.stale).toBe(true);
      expect(
        result.reasons.some((r) => r.includes("single model 'o3-mini' is no longer available"))
      ).toBe(true);
    });

    it("should mark stale when a multi-model tier model is no longer available", () => {
      const hostWithoutRoutineModel: HostCapabilities = {
        ...baseHostCapabilities,
        available_models: [
          { id: "gpt-4o", state: "available" },
          { id: "o3-mini", state: "available" },
          // "gpt-4o-mini" is gone!
        ],
      };

      const result = checkProfileStale(validMultiProfile, hostWithoutRoutineModel);
      expect(result.stale).toBe(true);
      expect(
        result.reasons.some((r) =>
          r.includes("Configured model 'gpt-4o-mini' for tier 'routine' is no longer available")
        )
      ).toBe(true);
    });

    it("should mark stale when configured model is present but marked state=unavailable", () => {
      const hostWithUnavailableModel: HostCapabilities = {
        ...baseHostCapabilities,
        available_models: [
          { id: "gpt-4o-mini", state: "available" },
          { id: "gpt-4o", state: "available" },
          { id: "o3-mini", state: "unavailable" }, // Unavailable!
        ],
      };

      const result = checkProfileStale(validSingleProfile, hostWithUnavailableModel);
      expect(result.stale).toBe(true);
      expect(
        result.reasons.some((r) => r.includes("single model 'o3-mini' is no longer available"))
      ).toBe(true);
    });

    it("should mark stale when a discrete effort value is no longer supported by host", () => {
      const hostWithLimitedEfforts: HostCapabilities = {
        ...baseHostCapabilities,
        supported_effort_values: ["low", "medium"], // "high" was dropped!
      };

      // In validMultiProfile, tier 'high' has effort: { value: 'high' }
      const result = checkProfileStale(validMultiProfile, hostWithLimitedEfforts);
      expect(result.stale).toBe(true);
      expect(
        result.reasons.some((r) =>
          r.includes("effort value 'high' for tier 'high' is no longer supported")
        )
      ).toBe(true);
    });

    it("should NOT mark stale when abstract effort policy (highest-supported) is used even if host supported values change", () => {
      const hostWithAlteredEfforts: HostCapabilities = {
        ...baseHostCapabilities,
        supported_effort_values: ["standard", "extra-high"],
      };

      // validSingleProfile uses { policy: "highest-supported" }, not a hardcoded discrete value
      const result = checkProfileStale(validSingleProfile, hostWithAlteredEfforts);
      expect(result.stale).toBe(false);
    });

    it("should mark stale when host capability regresses from available to unavailable", () => {
      const hostWithRegressedSubagents: HostCapabilities = {
        ...baseHostCapabilities,
        capabilities: {
          ...baseHostCapabilities.capabilities,
          subagents: { state: "unavailable" }, // Regressed!
        },
      };

      const result = checkProfileStale(validSingleProfile, hostWithRegressedSubagents);
      expect(result.stale).toBe(true);
      expect(
        result.reasons.some((r) => r.includes("Subagent capability was marked available in profile"))
      ).toBe(true);
    });

    it("should mark stale when multi-model profile runs on host where model_selection is unavailable", () => {
      const hostWithoutModelSelection: HostCapabilities = {
        ...baseHostCapabilities,
        capabilities: {
          ...baseHostCapabilities.capabilities,
          model_selection: { state: "unavailable" },
        },
      };

      const result = checkProfileStale(validMultiProfile, hostWithoutModelSelection);
      expect(result.stale).toBe(true);
      expect(
        result.reasons.some((r) =>
          r.includes("Profile requires multi-model mode, but host model selection capability is unavailable")
        )
      ).toBe(true);
    });
  });
});
