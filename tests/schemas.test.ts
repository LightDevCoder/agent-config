import { describe, it, expect, beforeAll } from "vitest";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ProfileSchema } from "../src/profile/schema.js";

const SCHEMAS_DIR = resolve(__dirname, "../schemas");

function loadSchema(filename: string) {
  const content = readFileSync(resolve(SCHEMAS_DIR, filename), "utf-8");
  return JSON.parse(content);
}

describe("Canonical JSON Schemas", () => {
  let ajv: Ajv;
  let validateProfile: any;
  let validateHostCapabilities: any;
  let validateExecutionConfig: any;

  beforeAll(() => {
    ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);

    const profileSchema = loadSchema("profile.schema.json");
    const hostCapabilitiesSchema = loadSchema("host-capabilities.schema.json");
    const executionConfigSchema = loadSchema("execution-config.schema.json");

    validateProfile = ajv.compile(profileSchema);
    validateHostCapabilities = ajv.compile(hostCapabilitiesSchema);
    validateExecutionConfig = ajv.compile(executionConfigSchema);
  });

  describe("profile.schema.json", () => {
    const baseValidSingleModel = {
      profile_version: 1,
      host: {
        id: "codex",
        adapter: "codex-adapter",
        platform: "darwin-arm64",
      },
      scope: {
        type: "project",
        workspace: "/workspace/my-project",
      },
      model_mode: "single",
      models: {
        available: ["gpt-4o", "o3-mini"],
      },
      single_model: {
        model: "o3-mini",
        execution_effort: {
          policy: "highest-supported",
        },
        review_effort: {
          policy: "highest-supported",
        },
      },
      capabilities: {
        subagents: "available",
        threads: "available",
        parallelism: "available",
        concurrency: 4,
      },
    };

    const baseValidMultiModel = {
      profile_version: 1,
      host: {
        id: "codex",
        adapter: "codex-adapter",
      },
      scope: {
        type: "project",
        workspace: "/workspace/my-project",
      },
      model_mode: "multi",
      models: {
        available: ["gpt-4o-mini", "gpt-4o", "o3-mini"],
      },
      tiers: {
        routine: {
          model: "gpt-4o-mini",
          effort: { value: "low" },
          source: "user-confirmed",
        },
        standard: {
          model: "gpt-4o",
          effort: { policy: "default" },
          source: "user-confirmed",
        },
        high: {
          model: "o3-mini",
          effort: { policy: "highest-supported" },
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
        concurrency: 2,
      },
    };

    it("accepts a valid single-model profile with abstract effort policy", () => {
      const valid = validateProfile(baseValidSingleModel);
      expect(validateProfile.errors).toBeNull();
      expect(valid).toBe(true);
      expect(() => ProfileSchema.parse(baseValidSingleModel)).not.toThrow();
    });

    it("accepts a valid single-model profile with concrete effort values", () => {
      const profile = {
        ...baseValidSingleModel,
        single_model: {
          model: "o3-mini",
          execution_effort: { value: "high" },
          review_effort: { value: "medium" },
        },
      };
      expect(validateProfile(profile)).toBe(true);
      expect(() => ProfileSchema.parse(profile)).not.toThrow();
    });

    it("accepts a valid multi-model profile with user-confirmed tiers", () => {
      const valid = validateProfile(baseValidMultiModel);
      expect(validateProfile.errors).toBeNull();
      expect(valid).toBe(true);
      expect(() => ProfileSchema.parse(baseValidMultiModel)).not.toThrow();
    });

    it("accepts a valid profile with global scope", () => {
      const globalProfile = {
        ...baseValidSingleModel,
        scope: {
          type: "global",
          workspace: "host-global",
        },
      };
      expect(validateProfile(globalProfile)).toBe(true);
      expect(() => ProfileSchema.parse(globalProfile)).not.toThrow();
    });

    it("rejects multi-model mode if tiers are missing", () => {
      const invalidMultiModel = {
        ...baseValidMultiModel,
        tiers: undefined,
      };
      expect(validateProfile(invalidMultiModel)).toBe(false);
      expect(() => ProfileSchema.parse(invalidMultiModel)).toThrow();
    });

    it("rejects multi-model mode if one of the 4 required tiers is missing", () => {
      const missingReviewTier = {
        ...baseValidMultiModel,
        tiers: {
          routine: baseValidMultiModel.tiers.routine,
          standard: baseValidMultiModel.tiers.standard,
          high: baseValidMultiModel.tiers.high,
          // review tier missing!
        },
      };
      expect(validateProfile(missingReviewTier)).toBe(false);
      expect(() => ProfileSchema.parse(missingReviewTier)).toThrow();
    });

    it("rejects single-model mode if single_model is missing", () => {
      const invalidSingleModel = {
        ...baseValidSingleModel,
        single_model: undefined,
      };
      expect(validateProfile(invalidSingleModel)).toBe(false);
      expect(() => ProfileSchema.parse(invalidSingleModel)).toThrow();
    });

    it("rejects single_model if model name is missing or empty", () => {
      const emptyModel = {
        ...baseValidSingleModel,
        single_model: { model: "" },
      };
      expect(validateProfile(emptyModel)).toBe(false);

      const missingModel = {
        ...baseValidSingleModel,
        single_model: {},
      };
      expect(validateProfile(missingModel)).toBe(false);
    });

    it("rejects profile_version < 1 or non-integer", () => {
      expect(validateProfile({ ...baseValidSingleModel, profile_version: 0 })).toBe(false);
      expect(validateProfile({ ...baseValidSingleModel, profile_version: -1 })).toBe(false);
      expect(validateProfile({ ...baseValidSingleModel, profile_version: "1" })).toBe(false);
    });

    it("rejects invalid scope type", () => {
      const invalidScope = {
        ...baseValidSingleModel,
        scope: { type: "local", workspace: "/test" },
      };
      expect(validateProfile(invalidScope)).toBe(false);
    });

    it("rejects missing scope workspace", () => {
      const missingWorkspace = {
        ...baseValidSingleModel,
        scope: { type: "project", workspace: "" },
      };
      expect(validateProfile(missingWorkspace)).toBe(false);
    });

    it("rejects invalid model_mode", () => {
      const invalidMode = {
        ...baseValidSingleModel,
        model_mode: "hybrid",
      };
      expect(validateProfile(invalidMode)).toBe(false);
    });

    it("rejects any profile containing routing_rank or unauthorized properties", () => {
      const profileWithRoutingRank = {
        ...baseValidSingleModel,
        routing_rank: 1, // FORBIDDEN
      };
      expect(validateProfile(profileWithRoutingRank)).toBe(false);

      const profileWithExtraField = {
        ...baseValidSingleModel,
        unauthorized_prop: "bad",
      };
      expect(validateProfile(profileWithExtraField)).toBe(false);
    });

    it("rejects tier mappings without user-confirmed provenance source", () => {
      const profileWithGuessedTier = {
        ...baseValidMultiModel,
        tiers: {
          ...baseValidMultiModel.tiers,
          routine: {
            model: "gpt-4o-mini",
            source: "inferred-by-agent", // FORBIDDEN
          },
        },
      };
      expect(validateProfile(profileWithGuessedTier)).toBe(false);
      expect(() => ProfileSchema.parse(profileWithGuessedTier)).toThrow();
    });

    it("rejects invalid capability state enums", () => {
      const invalidCapability = {
        ...baseValidSingleModel,
        capabilities: {
          subagents: "enabled", // Must be "available" | "unavailable" | "unknown"
        },
      };
      expect(validateProfile(invalidCapability)).toBe(false);
    });

    it("rejects concurrency < 1", () => {
      const invalidConcurrency = {
        ...baseValidSingleModel,
        capabilities: {
          concurrency: 0,
        },
      };
      expect(validateProfile(invalidConcurrency)).toBe(false);
    });
  });

  describe("host-capabilities.schema.json", () => {
    const validHostCapabilities = {
      host_id: "codex",
      adapter_id: "codex-adapter",
      workspace: "/workspace/my-project",
      observed_at: "2026-09-04T12:00:00Z",
      platform: "darwin-arm64",
      available_models: [
        {
          id: "gpt-4o",
          label: "GPT-4o",
          state: "available",
          features: ["tools", "vision"],
          evidence: {
            kind: "host-runtime",
            locator: "model selector",
          },
        },
        {
          id: "o3-mini",
          label: "o3-mini",
          state: "available",
          features: ["tools", "reasoning"],
          evidence: {
            kind: "host-runtime",
            locator: "model selector",
          },
        },
      ],
      supported_effort_values: ["low", "medium", "high"],
      default_effort_value: "medium",
      capabilities: {
        subagents: { state: "available" },
        threads: { state: "available" },
        parallelism: { state: "available" },
        model_selection: {
          state: "available",
          scopes: ["current-session", "new-session", "per-agent"],
        },
        concurrency: {
          state: "available",
          max_concurrency: 4,
        },
        configuration_mutation: {
          state: "available",
          supports_native_files: true,
          supports_session_mutation: false,
        },
      },
    };

    it("accepts valid host capabilities with discrete effort values and capability states", () => {
      const valid = validateHostCapabilities(validHostCapabilities);
      expect(validateHostCapabilities.errors).toBeNull();
      expect(valid).toBe(true);
    });

    it("rejects models containing routing_rank", () => {
      const invalidHostCapabilities = {
        ...validHostCapabilities,
        available_models: [
          {
            id: "gpt-4o",
            state: "available",
            routing_rank: 1, // FORBIDDEN
          },
        ],
      };
      expect(validateHostCapabilities(invalidHostCapabilities)).toBe(false);
    });

    it("rejects host capabilities missing required root properties", () => {
      const missingHostId = { ...validHostCapabilities, host_id: undefined };
      expect(validateHostCapabilities(missingHostId)).toBe(false);

      const missingAdapterId = { ...validHostCapabilities, adapter_id: undefined };
      expect(validateHostCapabilities(missingAdapterId)).toBe(false);

      const missingObservedAt = { ...validHostCapabilities, observed_at: undefined };
      expect(validateHostCapabilities(missingObservedAt)).toBe(false);

      const missingCapabilities = { ...validHostCapabilities, capabilities: undefined };
      expect(validateHostCapabilities(missingCapabilities)).toBe(false);

      const missingSupportedEffort = { ...validHostCapabilities, supported_effort_values: undefined };
      expect(validateHostCapabilities(missingSupportedEffort)).toBe(false);
    });

    it("rejects invalid date-time format for observed_at", () => {
      const invalidDate = {
        ...validHostCapabilities,
        observed_at: "not-a-valid-date-time",
      };
      expect(validateHostCapabilities(invalidDate)).toBe(false);
    });

    it("rejects model info missing id or state", () => {
      const missingId = {
        ...validHostCapabilities,
        available_models: [{ state: "available" }],
      };
      expect(validateHostCapabilities(missingId)).toBe(false);

      const missingState = {
        ...validHostCapabilities,
        available_models: [{ id: "m1" }],
      };
      expect(validateHostCapabilities(missingState)).toBe(false);
    });

    it("rejects capability entry with invalid state enum", () => {
      const invalidState = {
        ...validHostCapabilities,
        capabilities: {
          ...validHostCapabilities.capabilities,
          subagents: { state: "partial" }, // Invalid enum
        },
      };
      expect(validateHostCapabilities(invalidState)).toBe(false);
    });

    it("rejects model_selection with invalid scope enum", () => {
      const invalidScope = {
        ...validHostCapabilities,
        capabilities: {
          ...validHostCapabilities.capabilities,
          model_selection: {
            state: "available",
            scopes: ["unsupported-scope"],
          },
        },
      };
      expect(validateHostCapabilities(invalidScope)).toBe(false);
    });

    it("rejects concurrency capability with max_concurrency < 1", () => {
      const invalidConcurrency = {
        ...validHostCapabilities,
        capabilities: {
          ...validHostCapabilities.capabilities,
          concurrency: {
            state: "available",
            max_concurrency: 0,
          },
        },
      };
      expect(validateHostCapabilities(invalidConcurrency)).toBe(false);
    });
  });

  describe("execution-config.schema.json", () => {
    const validSinglePass = {
      task_shape: "single-pass",
      model_mode: "single",
      readiness: "executable",
      reason: "Bounded work item within single session",
      topology: {
        type: "single-session",
        concurrency: 1,
        fresh_contexts: false,
        subagent_contexts: false,
      },
      execution: {
        model: "o3-mini",
        effort: "high",
        effort_policy: "highest-supported",
        context: "current-session",
      },
      review: {
        strategy: "self-check",
        model: "o3-mini",
        effort: "high",
        context: "current-session",
      },
    };

    const validDecomposed = {
      task_shape: "decomposed",
      model_mode: "multi",
      readiness: "executable",
      reason: "Multi-ticket graph with dependencies",
      topology: {
        type: "controller-workers",
        concurrency: 2,
        fresh_contexts: true,
        subagent_contexts: true,
      },
      controller: {
        model: "o3-mini",
        effort: "high",
        effort_policy: "highest-supported",
        context: "main-session",
      },
      work_items: [
        {
          ticket_id: "01-init",
          difficulty: "routine",
          tier: "routine",
          model: "gpt-4o-mini",
          effort: "low",
          context: "worker-1",
          dependencies: [],
          review_strategy: "controller-review",
        },
        {
          ticket_id: "02-store",
          difficulty: "demanding",
          tier: "high",
          model: "o3-mini",
          effort: "high",
          context: "worker-2",
          dependencies: ["01-init"],
          review_strategy: "independent-review",
        },
      ],
      review: {
        strategy: "independent-review",
        tier: "review",
        model: "o3-mini",
        effort: "high",
        context: "fresh-session",
      },
    };

    it("accepts valid single-pass execution config", () => {
      const valid = validateExecutionConfig(validSinglePass);
      expect(validateExecutionConfig.errors).toBeNull();
      expect(valid).toBe(true);
    });

    it("accepts valid decomposed execution config with controller and work-items", () => {
      const valid = validateExecutionConfig(validDecomposed);
      expect(validateExecutionConfig.errors).toBeNull();
      expect(valid).toBe(true);
    });

    it("accepts execution config with optional preview metadata block", () => {
      const configWithPreview = {
        ...validSinglePass,
        preview: {
          preview_id: "preview-hash-abc12345",
          diff: "+model = \"o3-mini\"",
          mutation_targets: ["/path/.codex/config.toml"],
          created_at: "2026-09-04T12:00:00Z",
        },
      };
      expect(validateExecutionConfig(configWithPreview)).toBe(true);
    });

    it("rejects decomposed execution config if work_items are missing", () => {
      const invalidDecomposed = {
        ...validDecomposed,
        work_items: undefined,
      };
      expect(validateExecutionConfig(invalidDecomposed)).toBe(false);
    });

    it("rejects decomposed execution config if controller is missing", () => {
      const missingController = {
        ...validDecomposed,
        controller: undefined,
      };
      expect(validateExecutionConfig(missingController)).toBe(false);
    });

    it("rejects single-pass execution config if execution is missing", () => {
      const missingExecution = {
        ...validSinglePass,
        execution: undefined,
      };
      expect(validateExecutionConfig(missingExecution)).toBe(false);
    });

    it("rejects invalid task_shape enum", () => {
      const invalidTaskShape = {
        ...validSinglePass,
        task_shape: "parallel-orchestration",
      };
      expect(validateExecutionConfig(invalidTaskShape)).toBe(false);
    });

    it("rejects invalid readiness enum", () => {
      const invalidReadiness = {
        ...validSinglePass,
        readiness: "ready-to-run",
      };
      expect(validateExecutionConfig(invalidReadiness)).toBe(false);
    });

    it("rejects invalid topology type enum", () => {
      const invalidTopology = {
        ...validSinglePass,
        topology: {
          type: "swarm-cluster",
          concurrency: 1,
        },
      };
      expect(validateExecutionConfig(invalidTopology)).toBe(false);
    });

    it("rejects work item missing required fields", () => {
      const itemMissingTicketId = {
        ...validDecomposed,
        work_items: [
          {
            difficulty: "routine",
            model: "gpt-4o-mini",
            effort: "low",
            context: "worker-1",
          },
        ],
      };
      expect(validateExecutionConfig(itemMissingTicketId)).toBe(false);

      const itemMissingDifficulty = {
        ...validDecomposed,
        work_items: [
          {
            ticket_id: "01-init",
            model: "gpt-4o-mini",
            effort: "low",
            context: "worker-1",
          },
        ],
      };
      expect(validateExecutionConfig(itemMissingDifficulty)).toBe(false);
    });

    it("rejects work item with invalid difficulty enum", () => {
      const invalidDiff = {
        ...validDecomposed,
        work_items: [
          {
            ticket_id: "01-init",
            difficulty: "trivial", // Must be "routine" | "moderate" | "demanding" | "critical"
            model: "gpt-4o-mini",
            effort: "low",
            context: "worker-1",
          },
        ],
      };
      expect(validateExecutionConfig(invalidDiff)).toBe(false);
    });

    it("rejects review with invalid strategy enum", () => {
      const invalidStrategy = {
        ...validSinglePass,
        review: {
          strategy: "peer-agent-consensus",
          model: "o3-mini",
          effort: "high",
          context: "current-session",
        },
      };
      expect(validateExecutionConfig(invalidStrategy)).toBe(false);
    });
  });
});
