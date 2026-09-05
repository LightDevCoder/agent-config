import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { CodexAdapter } from "../src/adapters/codex/index.js";
import { OpenCodeAdapter } from "../src/adapters/opencode/index.js";
import { GenericAdapter } from "../src/adapters/generic/index.js";
import { CursorAdapter } from "../src/adapters/cursor/index.js";
import { checkProfileStale } from "../src/profile/stale.js";
import { HostCapabilities } from "../src/adapters/contract.js";
import { Profile, ExecutionConfig, ExecutionConfigSchema } from "../src/profile/schema.js";
import {
  inspectCompanionSetup,
  previewCompanionSetup,
  applyCompanionSetup,
  validateCompanionSetup,
} from "../src/setup/lifecycle.js";

describe("SPEC Acceptance Test Suite: Evidence, JSONC, Variants, Layering, and Stale", () => {
  let tempDir: string;
  let workspaceDir: string;

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "spec-acceptance-tests-"));
    workspaceDir = path.join(tempDir, "workspace");
    await fsp.mkdir(workspaceDir, { recursive: true });
  });

  afterEach(async () => {
    if (fs.existsSync(tempDir)) {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  describe("SPEC §38: Codex Adapter Host Evidence & Anti-Guessing", () => {
    it("Codex adapter does not invent model inventory when config is empty", async () => {
      const adapter = new CodexAdapter();
      const models = await adapter.inspectModels(workspaceDir);
      // Fails closed: empty inventory when unconfigured, never guesses gpt-5.6 or o3-mini
      expect(models).toEqual([]);
    });

    it("Codex adapter only reports configured model from config.toml", async () => {
      const codexDir = path.join(workspaceDir, ".codex");
      await fsp.mkdir(codexDir, { recursive: true });
      await fsp.writeFile(
        path.join(codexDir, "config.toml"),
        'model = "real-codex-model"\nmodel_reasoning_effort = "high"\n',
        "utf-8"
      );

      const adapter = new CodexAdapter();
      const models = await adapter.inspectModels(workspaceDir);
      expect(models).toHaveLength(1);
      expect(models[0].id).toBe("real-codex-model");
      expect(models[0].state).toBe("available");
    });

    it("Codex adapter does not invent max effort or concurrency limit", async () => {
      const adapter = new CodexAdapter();
      const caps = await adapter.inspectCapabilities(workspaceDir);

      // Never emits 'max' or synthesized ['low', 'medium', 'high'] unless evidenced in config
      expect(caps.supported_effort_values).not.toContain("max");
      expect(caps.supported_effort_values).toEqual([]);
      expect(caps.capabilities.reasoning?.state).toBe("unknown");

      // Concurrency and parallelism are unknown unless verified by config or environment
      expect(caps.capabilities.concurrency?.state).toBe("unknown");
      expect(caps.capabilities.concurrency?.max_concurrency).toBeUndefined();
      expect(caps.capabilities.parallelism.state).toBe("unknown");
    });

    it("Codex adapter detects explicit max_concurrency from config.toml", async () => {
      const codexDir = path.join(workspaceDir, ".codex");
      await fsp.mkdir(codexDir, { recursive: true });
      await fsp.writeFile(
        path.join(codexDir, "config.toml"),
        'max_concurrency = 8\n',
        "utf-8"
      );

      const adapter = new CodexAdapter();
      const caps = await adapter.inspectCapabilities(workspaceDir);
      expect(caps.capabilities.concurrency?.state).toBe("available");
      expect(caps.capabilities.concurrency?.max_concurrency).toBe(8);
    });
  });

  describe("SPEC §39: OpenCode JSONC Safety & Preservation", () => {
    it("reads JSONC with single-line and multi-line comments", async () => {
      const adapter = new OpenCodeAdapter();
      const jsoncContent = `
      // Single-line comment
      /* Multi-line
         comment */
      {
        "model": "provider-x/model-1"
      }
      `;
      const parsed = adapter.parseJsonc(jsoncContent);
      expect(parsed.model).toBe("provider-x/model-1");
    });

    it("reads JSONC with trailing commas in objects and arrays", async () => {
      const adapter = new OpenCodeAdapter();
      const jsoncContent = `
      {
        "model": "provider-x/model-1",
        "plugin": ["a", "b",],
      }
      `;
      const parsed = adapter.parseJsonc(jsoncContent);
      expect(parsed.model).toBe("provider-x/model-1");
      expect(parsed.plugin).toEqual(["a", "b"]);
    });

    it("fails closed on parse failure: rejects preview and never rewrites target file with empty config", async () => {
      const adapter = new OpenCodeAdapter();
      const targetFile = path.join(workspaceDir, "opencode.jsonc");
      const malformedContent = `
      {
        "model": "unclosed-string,
        "plugin": ["broken"
      `;
      await fsp.writeFile(targetFile, malformedContent, "utf-8");

      const plan: ExecutionConfig = {
        task_shape: "single-pass",
        model_mode: "single",
        readiness: "executable",
        topology: { type: "single-session", concurrency: 1 },
        execution: { model: "safe-model", effort: "high", context: "main" },
        review: { strategy: "self-check", model: "safe-model", effort: "high", context: "main" },
      };

      // Must throw clear diagnostic and reject mutation
      await expect(adapter.renderConfiguration(plan, undefined, workspaceDir)).rejects.toThrow(
        /syntax errors\. Rejecting mutation to prevent configuration loss/
      );

      // Verify original file remained intact and was not overwritten with {}
      const postContent = await fsp.readFile(targetFile, "utf-8");
      expect(postContent).toBe(malformedContent);
    });

    it("preserves unrelated fields, plugins, permissions, formatters, and comments during mutation", async () => {
      const adapter = new OpenCodeAdapter();
      const targetFile = path.join(workspaceDir, "opencode.jsonc");
      const richContent = `// Critical user comments
{
  // Plugin settings
  "plugin": ["custom-linter", "formatter-plugin"],
  "permission": {
    "terminal": "ask"
  },
  "formatters": {
    "typescript": "prettier"
  },
  "custom_user_field": { "preserve_me": true },
  "model": "old-provider/old-model",
}
`;
      await fsp.writeFile(targetFile, richContent, "utf-8");

      const plan: ExecutionConfig = {
        task_shape: "single-pass",
        model_mode: "single",
        readiness: "executable",
        topology: { type: "single-session", concurrency: 1 },
        execution: { model: "new-provider/new-model", effort: "high", context: "main" },
        review: { strategy: "self-check", model: "new-provider/new-model", effort: "high", context: "main" },
      };

      const rendered = await adapter.renderConfiguration(plan, undefined, workspaceDir);
      await adapter.applyConfiguration(rendered.preview_id, rendered, workspaceDir);

      const updatedContent = await fsp.readFile(targetFile, "utf-8");

      // Verify comments and unrelated keys are preserved
      expect(updatedContent).toContain("// Critical user comments");
      expect(updatedContent).toContain('"custom-linter"');
      expect(updatedContent).toContain('"terminal": "ask"');
      expect(updatedContent).toContain('"preserve_me": true');
      expect(updatedContent).toContain('"model": "new-provider/new-model"');
    });
  });

  describe("SPEC §40: OpenCode Model-Specific Variant Mapping", () => {
    it("discovers different available variants for different models", async () => {
      const targetFile = path.join(workspaceDir, "opencode.jsonc");
      const providerContent = `
      {
        "provider": {
          "custom-prov": {
            "models": {
              "model-a": {
                "name": "Model A",
                "variants": ["low", "medium", "high"]
              },
              "model-b": {
                "name": "Model B",
                "variants": ["high", "max"]
              }
            }
          }
        }
      }
      `;
      await fsp.writeFile(targetFile, providerContent, "utf-8");

      const adapter = new OpenCodeAdapter();
      const models = await adapter.inspectModels(workspaceDir);

      const modelA = models.find((m) => m.id === "custom-prov/model-a");
      const modelB = models.find((m) => m.id === "custom-prov/model-b");

      expect(modelA).toBeDefined();
      expect(modelA!.features).toContain("variant:low");
      expect(modelA!.features).toContain("variant:medium");
      expect(modelA!.features).toContain("variant:high");

      expect(modelB).toBeDefined();
      expect(modelB!.features).toContain("variant:high");
      expect(modelB!.features).toContain("variant:max");
    });

    it("applies model-specific variant in decomposed multi-model configuration", async () => {
      const targetFile = path.join(workspaceDir, "opencode.jsonc");
      const providerContent = `
      {
        "provider": {
          "custom-prov": {
            "models": {
              "model-a": { "variants": ["low", "medium", "high"] },
              "model-b": { "variants": ["high", "max"] }
            }
          }
        }
      }
      `;
      await fsp.writeFile(targetFile, providerContent, "utf-8");

      const adapter = new OpenCodeAdapter();

      const decomposedPlan: ExecutionConfig = {
        task_shape: "decomposed",
        model_mode: "multi",
        readiness: "executable",
        topology: { type: "controller-workers", concurrency: 2 },
        controller: { model: "custom-prov/model-b", effort: "max", context: "main" },
        work_items: [
          {
            ticket_id: "01-routine",
            difficulty: "routine",
            model: "custom-prov/model-a",
            effort: "low",
            effort_policy: "lowest-sufficient",
            context: "worker-1",
          },
          {
            ticket_id: "02-demanding",
            difficulty: "demanding",
            model: "custom-prov/model-b",
            effort: "max",
            effort_policy: "highest-supported",
            context: "worker-2",
          },
        ],
        review: { strategy: "controller-review", model: "custom-prov/model-b", effort: "max", context: "main" },
      };

      const rendered = await adapter.renderConfiguration(decomposedPlan, undefined, workspaceDir);
      await adapter.applyConfiguration(rendered.preview_id, rendered, workspaceDir);

      const content = await fsp.readFile(targetFile, "utf-8");
      const parsed = adapter.parseJsonc(content);

      expect(parsed.agent["01-routine"].model).toBe("custom-prov/model-a");
      expect(parsed.agent["01-routine"].variant).toBe("low");

      expect(parsed.agent["02-demanding"].model).toBe("custom-prov/model-b");
      expect(parsed.agent["02-demanding"].variant).toBe("max");
    });
  });

  describe("SPEC §41: OpenCode Effective Config vs Mutation Target Layering", () => {
    it("inspects across layers but only mutates the designated target layer without flattening", async () => {
      // Simulate global config directory
      const globalConfigDir = path.join(tempDir, "global-opencode");
      await fsp.mkdir(globalConfigDir, { recursive: true });
      process.env.OPENCODE_CONFIG_DIR = globalConfigDir;

      const globalConfigPath = path.join(globalConfigDir, "opencode.json");
      await fsp.writeFile(
        globalConfigPath,
        JSON.stringify({
          global_setting: "from-global",
          provider: {
            "global-prov": {
              models: { "global-model": { name: "Global Model" } },
            },
          },
        }),
        "utf-8"
      );

      // Project level config
      const projectConfigPath = path.join(workspaceDir, "opencode.jsonc");
      await fsp.writeFile(
        projectConfigPath,
        '{\n  "project_setting": "from-project",\n  "model": "old-model"\n}\n',
        "utf-8"
      );

      const adapter = new OpenCodeAdapter();

      // 1. Effective inspection sees models from global layer
      const models = await adapter.inspectModels(workspaceDir);
      expect(models.some((m) => m.id === "global-prov/global-model")).toBe(true);

      // 2. Mutation targets ONLY the project file
      const plan: ExecutionConfig = {
        task_shape: "single-pass",
        model_mode: "single",
        readiness: "executable",
        topology: { type: "single-session", concurrency: 1 },
        execution: { model: "global-prov/global-model", effort: "high", context: "main" },
        review: { strategy: "self-check", model: "global-prov/global-model", effort: "high", context: "main" },
      };

      const rendered = await adapter.renderConfiguration(plan, undefined, workspaceDir);
      expect(rendered.mutation_targets).toEqual([projectConfigPath]);

      await adapter.applyConfiguration(rendered.preview_id, rendered, workspaceDir);

      // 3. Project file updated without flattening global_setting into it
      const projectContent = await fsp.readFile(projectConfigPath, "utf-8");
      const parsedProject = adapter.parseJsonc(projectContent);
      expect(parsedProject.project_setting).toBe("from-project");
      expect(parsedProject.model).toBe("global-prov/global-model");
      expect(parsedProject.global_setting).toBeUndefined(); // NOT flattened!

      // 4. Global file untouched
      const globalContent = await fsp.readFile(globalConfigPath, "utf-8");
      expect(globalContent).toContain('"from-global"');

      delete process.env.OPENCODE_CONFIG_DIR;
    });
  });

  describe("SPEC §42: Stale Detection & Fail Closed on Unknown Capability", () => {
    const baseCaps: HostCapabilities = {
      host_id: "generic",
      adapter_id: "generic",
      observed_at: new Date().toISOString(),
      available_models: [{ id: "model-x", state: "available" }],
      supported_effort_values: ["low", "medium", "high"],
      capabilities: {
        subagents: { state: "available" },
        threads: { state: "available" },
        parallelism: { state: "available" },
        model_selection: { state: "available" },
      },
    };

    const validProfile: Profile = {
      profile_version: 1,
      host: { id: "generic", adapter: "generic" },
      scope: { type: "project", workspace: "/test" },
      model_mode: "single",
      single_model: {
        model: "model-x",
        execution_effort: { policy: "highest-supported" },
      },
      capabilities: {
        subagents: "available",
        threads: "available",
      },
    };

    it("marks profile valid when host models and capabilities are confirmed available", () => {
      const result = checkProfileStale(validProfile, baseCaps);
      expect(result.stale).toBe(false);
      expect(result.reasons).toHaveLength(0);
    });

    it("fails closed when configured model capability state becomes unknown", () => {
      const unknownModelCaps: HostCapabilities = {
        ...baseCaps,
        available_models: [{ id: "model-x", state: "unknown" }],
      };
      const result = checkProfileStale(validProfile, unknownModelCaps);
      expect(result.stale).toBe(true);
      expect(result.reasons.some((r) => r.includes("model 'model-x'"))).toBe(true);
    });

    it("fails closed when required subagent capability becomes unknown", () => {
      const unknownSubagentCaps: HostCapabilities = {
        ...baseCaps,
        capabilities: {
          ...baseCaps.capabilities,
          subagents: { state: "unknown" },
        },
      };
      const result = checkProfileStale(validProfile, unknownSubagentCaps);
      expect(result.stale).toBe(true);
      expect(result.reasons.some((r) => r.includes("Subagent capability was marked available in profile but is now unknown"))).toBe(true);
    });

    it("fails closed when multi-model profile runs on host with unknown model selection", () => {
      const multiProfile: Profile = {
        profile_version: 1,
        host: { id: "generic", adapter: "generic" },
        scope: { type: "project", workspace: "/test" },
        model_mode: "multi",
        tiers: {
          routine: { model: "model-x", source: "user-confirmed" },
          standard: { model: "model-x", source: "user-confirmed" },
          high: { model: "model-x", source: "user-confirmed" },
          review: { model: "model-x", source: "user-confirmed" },
        },
      };

      const unknownModelSelCaps: HostCapabilities = {
        ...baseCaps,
        capabilities: {
          ...baseCaps.capabilities,
          model_selection: { state: "unknown" },
        },
      };

      const result = checkProfileStale(multiProfile, unknownModelSelCaps);
      expect(result.stale).toBe(true);
      expect(result.reasons.some((r) => r.includes("host model selection capability is unknown"))).toBe(true);
    });

    it("detects stale profile when profile scope does not match host workspace (SPEC §13, §66)", () => {
      const mismatchedScopeProfile: Profile = {
        ...validProfile,
        scope: {
          type: "project",
          workspace: "/some/other/workspace",
        },
      };

      // When checking against a host with different adapter or mismatch
      const mismatchHostCaps: HostCapabilities = {
        ...baseCaps,
        adapter_id: "codex",
        host_id: "codex",
      };

      const result = checkProfileStale(mismatchedScopeProfile, mismatchHostCaps);
      expect(result.stale).toBe(true);
      expect(result.reasons.some((r) => r.includes("Adapter mismatch") || r.includes("Host ID mismatch"))).toBe(true);
    });
  });

  describe("SPEC §89: User-Focused Acceptance Scenarios (Case A through Case F)", () => {
    it("Case A — Codex: multi-model, tickets, workers -> Profile tiers -> model/effort routing", async () => {
      const codexDir = path.join(workspaceDir, ".codex");
      await fsp.mkdir(codexDir, { recursive: true });

      // Profile declaring multi-model tiers
      const multiModelProfile: Profile = {
        profile_version: 1,
        host: { id: "codex", adapter: "codex" },
        scope: { type: "project", workspace: workspaceDir },
        model_mode: "multi",
        tiers: {
          routine: { model: "gpt-4o-mini", effort: "low", source: "user-confirmed" },
          standard: { model: "gpt-4o", effort: "medium", source: "user-confirmed" },
          high: { model: "o3-mini", effort: "high", source: "user-confirmed" },
          review: { model: "o3-mini", effort: "high", source: "user-confirmed" },
        },
      };

      // Decomposed execution config routing tickets to workers based on profile tiers
      const executionPlan: ExecutionConfig = {
        task_shape: "decomposed",
        model_mode: "multi",
        readiness: "executable",
        topology: { type: "controller-workers", concurrency: 2 },
        controller: {
          model: multiModelProfile.tiers!.high.model,
          effort: multiModelProfile.tiers!.high.effort,
          context: "main",
        },
        work_items: [
          {
            ticket_id: "01-routine-task",
            difficulty: "routine",
            model: multiModelProfile.tiers!.routine.model,
            effort: multiModelProfile.tiers!.routine.effort,
            effort_policy: "lowest-sufficient",
            context: "worker-1",
          },
          {
            ticket_id: "02-demanding-task",
            difficulty: "demanding",
            model: multiModelProfile.tiers!.high.model,
            effort: multiModelProfile.tiers!.high.effort,
            effort_policy: "highest-supported",
            context: "worker-2",
          },
        ],
        review: {
          strategy: "controller-review",
          model: multiModelProfile.tiers!.review.model,
          effort: multiModelProfile.tiers!.review.effort,
          context: "main",
        },
      };

      expect(ExecutionConfigSchema.safeParse(executionPlan).success).toBe(true);

      const adapter = new CodexAdapter();
      const rendered = await adapter.renderConfiguration(executionPlan, multiModelProfile, workspaceDir);

      // Verify mutation targets include controller config.toml and per-worker agent configs
      expect(rendered.mutation_targets).toContain(path.join(codexDir, "config.toml"));
      expect(rendered.mutation_targets).toContain(path.join(codexDir, "agents", "01-routine-task.toml"));
      expect(rendered.mutation_targets).toContain(path.join(codexDir, "agents", "02-demanding-task.toml"));

      await adapter.applyConfiguration(rendered.preview_id, rendered, workspaceDir);

      // Inspect applied files to ensure model & effort routing matched profile tiers
      const controllerToml = await fsp.readFile(path.join(codexDir, "config.toml"), "utf-8");
      expect(controllerToml).toContain('model = "o3-mini"');
      expect(controllerToml).toContain('model_reasoning_effort = "high"');

      const worker1Toml = await fsp.readFile(path.join(codexDir, "agents", "01-routine-task.toml"), "utf-8");
      expect(worker1Toml).toContain('model = "gpt-4o-mini"');
      expect(worker1Toml).toContain('model_reasoning_effort = "low"');

      const worker2Toml = await fsp.readFile(path.join(codexDir, "agents", "02-demanding-task.toml"), "utf-8");
      expect(worker2Toml).toContain('model = "o3-mini"');
      expect(worker2Toml).toContain('model_reasoning_effort = "high"');
    });

    it("Case B — Single-model Harness: single model, tickets -> same model -> worker or serial topology", async () => {
      // Profile for single-model harness
      const singleModelProfile: Profile = {
        profile_version: 1,
        host: { id: "claude-code", adapter: "claude-code" },
        scope: { type: "project", workspace: workspaceDir },
        model_mode: "single",
        single_model: {
          model: "claude-3-7-sonnet",
          execution_effort: { policy: "lowest-sufficient" },
          review_effort: { policy: "highest-supported" },
        },
      };

      // Decomposed tickets executed with single model across workers / serial topology
      const singleModelPlan: ExecutionConfig = {
        task_shape: "decomposed",
        model_mode: "single",
        readiness: "executable",
        topology: { type: "serial-tickets", concurrency: 1 },
        controller: {
          model: singleModelProfile.single_model!.model,
          effort: "medium",
          context: "main",
        },
        work_items: [
          {
            ticket_id: "01-frontend",
            difficulty: "routine",
            model: singleModelProfile.single_model!.model,
            effort: "low",
            context: "step-1",
          },
          {
            ticket_id: "02-backend",
            difficulty: "demanding",
            model: singleModelProfile.single_model!.model,
            effort: "high",
            context: "step-2",
          },
        ],
        review: {
          strategy: "self-check",
          model: singleModelProfile.single_model!.model,
          effort: "high",
          context: "main",
        },
      };

      // Validates under strict ExecutionConfig schema
      const parseResult = ExecutionConfigSchema.safeParse(singleModelPlan);
      expect(parseResult.success).toBe(true);

      // Verify all work items and review use the same single model (no extra models invented)
      expect(singleModelPlan.controller?.model).toBe("claude-3-7-sonnet");
      expect(singleModelPlan.work_items?.every((w) => w.model === "claude-3-7-sonnet")).toBe(true);
      expect(singleModelPlan.review.model).toBe("claude-3-7-sonnet");
    });

    it("Case C — Companion missing: agent-config -> offer setup -> no silent install", async () => {
      const adapter = new CursorAdapter();

      // In clean workspace, companion is not registered
      const inspection = await inspectCompanionSetup({
        workspace: workspaceDir,
        host_id: "cursor",
        scope: "project",
      });

      expect(inspection.registered).toBe(false);

      // Verify no silent install: no files created by inspection
      const cursorConfigDir = path.join(workspaceDir, ".cursor");
      expect(fs.existsSync(cursorConfigDir)).toBe(false);

      // Setup is offered via preview
      const preview = await previewCompanionSetup({
        workspace: workspaceDir,
        host_id: "cursor",
        scope: "project",
      });

      expect(preview.supported).toBe(true);
      expect(preview.target_file).toBe(path.join(cursorConfigDir, "mcp.json"));
      expect(preview.diff).toContain("+    \"agent-config\"");

      // Refuses to apply mutation without explicit user approval (--yes)
      const unapprovedApply = await applyCompanionSetup({
        workspace: workspaceDir,
        host_id: "cursor",
        scope: "project",
        preview_hash: preview.preview_hash,
        explicit_approval: false,
      });

      expect(unapprovedApply.success).toBe(false);
      expect(unapprovedApply.error).toContain("ApprovalRequiredError");

      // Still no file modified without approval
      expect(fs.existsSync(cursorConfigDir)).toBe(false);
    });

    it("Case D — Unsupported Harness: Generic/manual -> explicit user-confirmed Profile -> plan-only", async () => {
      const adapter = new GenericAdapter();

      // Generic adapter fails closed for mutations
      const version = await adapter.inspectVersion(workspaceDir);
      expect(version.fail_closed_for_mutation).toBe(true);

      const caps = await adapter.inspectCapabilities(workspaceDir);
      expect(caps.capabilities.configuration_mutation?.supports_session_mutation).toBe(false);

      const manualProfile: Profile = {
        profile_version: 1,
        host: { id: "generic", adapter: "generic" },
        scope: { type: "project", workspace: workspaceDir },
        model_mode: "single",
        single_model: {
          model: "custom-local-model",
          execution_effort: { policy: "highest-supported" },
        },
      };

      const plan: ExecutionConfig = {
        task_shape: "single-pass",
        model_mode: "single",
        readiness: "executable",
        topology: { type: "single-session", concurrency: 1 },
        execution: { model: "custom-local-model", effort: "high", context: "main" },
        review: { strategy: "self-check", model: "custom-local-model", effort: "high", context: "main" },
      };

      // Plan rendering succeeds in plan-only mode (zero mutation targets, zero files modified)
      const rendered = await adapter.renderConfiguration(plan, manualProfile, workspaceDir);
      expect(rendered.mutation_targets).toEqual([]);
      expect(rendered.files).toEqual([]);
      expect(rendered.diff).toContain("# Generic Plan-Only Configuration Preview");
      expect(rendered.diff).toContain("Mutation Targets: None (plan-only manual execution)");
      expect(rendered.diff).toContain("Task Shape: single-pass");

      // Mutation apply is strictly plan-only: applied_targets is empty
      const applyResult = await adapter.applyConfiguration(rendered.preview_id, rendered, workspaceDir);
      expect(applyResult.success).toBe(true);
      expect(applyResult.applied_targets).toEqual([]);
      expect(applyResult.message).toContain("Generic adapter is plan-only: no host mutations performed.");

      // Companion mutation is strictly rejected
      const companionApply = await adapter.applyCompanionRegistration(workspaceDir);
      expect(companionApply.success).toBe(false);
      expect(companionApply.error).toContain("Companion registration mutation is unsupported for generic host.");
    });

    it("Case E — Host capability unknown: unknown -> no guessing", async () => {
      // Empty workspace without host evidence
      const adapter = new CodexAdapter();
      const caps = await adapter.inspectCapabilities(workspaceDir);

      // Reasoning capability is unknown, effort values are empty
      expect(caps.capabilities.reasoning?.state).toBe("unknown");
      expect(caps.supported_effort_values).toEqual([]);

      // Concurrency and parallelism are unknown (no guessing concurrency limits)
      expect(caps.capabilities.concurrency?.state).toBe("unknown");
      expect(caps.capabilities.concurrency?.max_concurrency).toBeUndefined();
      expect(caps.capabilities.parallelism.state).toBe("unknown");

      // Models list fails closed: empty inventory when unconfigured
      const models = await adapter.inspectModels(workspaceDir);
      expect(models).toEqual([]);
    });

    it("Case F — Project-scope MCP setup: preview project target -> approval -> apply exact project target -> validate exact project registration", async () => {
      const adapter = new CursorAdapter();

      // 1. Preview project target
      const preview = await previewCompanionSetup({
        workspace: workspaceDir,
        host_id: "cursor",
        scope: "project",
      });

      const projectTargetPath = path.join(workspaceDir, ".cursor", "mcp.json");
      expect(preview.target_file).toBe(projectTargetPath);
      expect(preview.scope).toBe("project");

      // 2. Explicit approval and apply exact project target
      const applyResult = await applyCompanionSetup({
        workspace: workspaceDir,
        host_id: "cursor",
        scope: "project",
        preview_hash: preview.preview_hash,
        explicit_approval: true,
        frozen_preview: preview,
      });

      expect(applyResult.success).toBe(true);
      expect(applyResult.applied_targets).toEqual([projectTargetPath]);
      expect(fs.existsSync(projectTargetPath)).toBe(true);

      // 3. Validate exact project registration
      const validation = await validateCompanionSetup({
        workspace: workspaceDir,
        host_id: "cursor",
        scope: "project",
      });

      expect(validation.valid).toBe(true);
      expect(validation.registered).toBe(true);
      expect(validation.configured).toBe(true);

      const postInspection = await inspectCompanionSetup({
        workspace: workspaceDir,
        host_id: "cursor",
        scope: "project",
      });
      expect(postInspection.registered).toBe(true);
      expect(postInspection.locator).toBe(projectTargetPath);
    });
  });
});
