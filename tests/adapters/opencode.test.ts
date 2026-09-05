import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { OpenCodeAdapter } from "../../src/adapters/opencode/index.js";
import { ExecutionConfig } from "../../src/profile/schema.js";

describe("OpenCode Native Adapter Hardening Tests (§29, §30, §31, §32, §75)", () => {
  let tempDir: string;
  let workspaceDir: string;
  let globalConfigDir: string;
  let originalEnv: {
    OPENCODE_CONFIG_DIR?: string;
    OPENCODE_MAX_CONCURRENCY?: string;
  };

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "opencode-hardening-test-"));
    workspaceDir = path.join(tempDir, "workspace");
    globalConfigDir = path.join(tempDir, "global-config");
    await fsp.mkdir(workspaceDir, { recursive: true });
    await fsp.mkdir(globalConfigDir, { recursive: true });

    originalEnv = {
      OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR,
      OPENCODE_MAX_CONCURRENCY: process.env.OPENCODE_MAX_CONCURRENCY,
    };

    process.env.OPENCODE_CONFIG_DIR = globalConfigDir;
    delete process.env.OPENCODE_MAX_CONCURRENCY;
  });

  afterEach(async () => {
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v === undefined) delete (process.env as any)[k];
      else (process.env as any)[k] = v;
    }

    if (fs.existsSync(tempDir)) {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  describe("Config Precedence (§30)", () => {
    it("project model variants override global model variants without unioning or flattening", async () => {
      // 1. Global config defines openai/gpt-4o with variants = ["low"]
      const globalConfig = {
        model: "openai/gpt-4o",
        provider: {
          openai: {
            models: {
              "gpt-4o": {
                variants: ["low"],
              },
            },
          },
        },
      };
      await fsp.writeFile(
        path.join(globalConfigDir, "opencode.json"),
        JSON.stringify(globalConfig, null, 2),
        "utf-8"
      );

      // 2. Project config defines the same model with variants = ["high"]
      const projectConfig = {
        provider: {
          openai: {
            models: {
              "gpt-4o": {
                variants: ["high"],
              },
            },
          },
        },
      };
      await fsp.writeFile(
        path.join(workspaceDir, "opencode.json"),
        JSON.stringify(projectConfig, null, 2),
        "utf-8"
      );

      const adapter = new OpenCodeAdapter();

      // Models inspection: gpt-4o should have ONLY variant:high
      const models = await adapter.inspectModels(workspaceDir);
      const gpt4o = models.find((m) => m.id === "openai/gpt-4o");
      expect(gpt4o).toBeDefined();
      expect(gpt4o?.features).toContain("variant:high");
      expect(gpt4o?.features).not.toContain("variant:low");

      // Effort values inspection: must be ["high"], NOT ["low", "high"]
      const effortValues = await adapter.inspectEffortValues(workspaceDir);
      expect(effortValues).toEqual(["high"]);

      // Policy resolution: highest-supported and lowest-sufficient both resolve to "high"
      const highPolicy = await adapter.resolveReasoningPolicy(
        "highest-supported",
        "openai/gpt-4o",
        workspaceDir
      );
      expect(highPolicy).toEqual({
        host_field: "variant",
        host_value: "high",
      });

      const lowPolicy = await adapter.resolveReasoningPolicy(
        "lowest-sufficient",
        "openai/gpt-4o",
        workspaceDir
      );
      expect(lowPolicy).toEqual({
        host_field: "variant",
        host_value: "high",
      });
    });

    it("project overrides global selected model and concurrency limit", async () => {
      await fsp.writeFile(
        path.join(globalConfigDir, "opencode.json"),
        JSON.stringify({
          model: "global-provider/global-model",
          max_concurrency: 2,
        }),
        "utf-8"
      );

      await fsp.writeFile(
        path.join(workspaceDir, "opencode.json"),
        JSON.stringify({
          model: "project-provider/project-model",
          max_concurrency: 8,
        }),
        "utf-8"
      );

      const adapter = new OpenCodeAdapter();
      const caps = await adapter.inspectCapabilities(workspaceDir);

      expect(caps.capabilities.concurrency?.max_concurrency).toBe(8);
      expect(caps.capabilities.parallelism.state).toBe("available");

      const models = await adapter.inspectModels(workspaceDir);
      expect(models[0].id).toBe("project-provider/project-model");
    });

    it("project inherits non-conflicting global providers and models", async () => {
      await fsp.writeFile(
        path.join(globalConfigDir, "opencode.json"),
        JSON.stringify({
          provider: {
            anthropic: {
              models: {
                "claude-3-7-sonnet": { name: "Claude Sonnet" },
              },
            },
          },
        }),
        "utf-8"
      );

      await fsp.writeFile(
        path.join(workspaceDir, "opencode.json"),
        JSON.stringify({
          provider: {
            openai: {
              models: {
                "o3-mini": { name: "O3 Mini" },
              },
            },
          },
        }),
        "utf-8"
      );

      const adapter = new OpenCodeAdapter();
      const models = await adapter.inspectModels(workspaceDir);

      expect(models.some((m) => m.id === "anthropic/claude-3-7-sonnet")).toBe(true);
      expect(models.some((m) => m.id === "openai/o3-mini")).toBe(true);
    });

    it("project strictly overrides conflicting global settings (SPEC §44: effective value MUST be project, NOT union or first-found)", async () => {
      // Global defines setting X across multiple fields (model, variant, concurrency, theme, mcp)
      await fsp.writeFile(
        path.join(globalConfigDir, "opencode.json"),
        JSON.stringify({
          model: "global/model-x",
          variant: "low",
          concurrency: 2,
          theme: "dark-theme",
          agent: {
            "ticket-worker": {
              model: "global/worker-model",
              variant: "low",
            },
          },
          mcp: {
            servers: {
              shared_service: {
                command: "global-cmd",
                args: ["--global"],
              },
              global_only_service: {
                command: "global-only-cmd",
              },
            },
          },
        }, null, 2),
        "utf-8"
      );

      // Project defines conflicting setting X
      await fsp.writeFile(
        path.join(workspaceDir, "opencode.json"),
        JSON.stringify({
          model: "project/model-x",
          variant: "max",
          concurrency: 16,
          theme: "light-theme",
          agent: {
            "ticket-worker": {
              model: "project/worker-model",
              variant: "high",
            },
          },
          mcp: {
            servers: {
              shared_service: {
                command: "project-cmd",
                args: ["--project"],
              },
            },
          },
        }, null, 2),
        "utf-8"
      );

      const adapter = new OpenCodeAdapter();
      const { config: effective } = adapter.getEffectiveConfig(workspaceDir);

      // 1. Primitive fields MUST be project value, NOT global value or union
      expect(effective.model).toBe("project/model-x");
      expect(effective.variant).toBe("max");
      expect(effective.concurrency).toBe(16);
      expect(effective.theme).toBe("light-theme");

      // 2. Agent subagent definitions MUST be project value
      expect(effective.agent["ticket-worker"]).toEqual({
        model: "project/worker-model",
        variant: "high",
      });

      // 3. MCP server matching the same name MUST be overridden by project value
      expect(effective.mcp.servers.shared_service).toEqual({
        command: "project-cmd",
        args: ["--project"],
      });
      // Non-conflicting global MCP server is retained
      expect(effective.mcp.servers.global_only_service).toEqual({
        command: "global-only-cmd",
      });
    });
  });

  describe("Mutation Target Isolation & Comment Preservation (§31)", () => {
    it("preserves comments, trailing commas, and unrelated fields when mutating project layer", async () => {
      const richJsonc = `// OpenCode workspace configuration
{
  // User selected default model
  "model": "old-provider/old-model",
  /* Custom linter settings */
  "linter": {
    "strict": true,
  },
  "plugins": [
    "git-tools",
    "test-runner",
  ],
}
`;
      const projectTarget = path.join(workspaceDir, "opencode.jsonc");
      await fsp.writeFile(projectTarget, richJsonc, "utf-8");

      const adapter = new OpenCodeAdapter();
      const plan: ExecutionConfig = {
        task_shape: "single-pass",
        model_mode: "single",
        readiness: "executable",
        topology: { type: "single-session", concurrency: 1 },
        execution: { model: "anthropic/claude-3-7-sonnet", effort: "high", context: "main" },
        review: { strategy: "self-check", model: "anthropic/claude-3-7-sonnet", effort: "high", context: "main" },
      };

      const rendered = await adapter.renderConfiguration(plan, undefined, workspaceDir);
      expect(rendered.mutation_targets).toEqual([projectTarget]);

      await adapter.applyConfiguration(rendered.preview_id, rendered, workspaceDir);

      const updatedContent = await fsp.readFile(projectTarget, "utf-8");

      // Verify comments preserved
      expect(updatedContent).toContain("// OpenCode workspace configuration");
      expect(updatedContent).toContain("// User selected default model");
      expect(updatedContent).toContain("/* Custom linter settings */");

      // Verify fields preserved
      expect(updatedContent).toContain('"strict": true');
      expect(updatedContent).toContain('"git-tools"');

      // Verify model updated
      expect(updatedContent).toContain('"model": "anthropic/claude-3-7-sonnet"');
    });

    it("does not flatten global config keys into project mutation target", async () => {
      await fsp.writeFile(
        path.join(globalConfigDir, "opencode.json"),
        JSON.stringify({
          global_only_key: "should-not-leak",
          theme: "solarized-dark",
        }),
        "utf-8"
      );

      const projectFile = path.join(workspaceDir, "opencode.json");
      await fsp.writeFile(
        projectFile,
        JSON.stringify({
          project_key: "local-only",
          model: "old-model",
        }),
        "utf-8"
      );

      const adapter = new OpenCodeAdapter();
      const plan: ExecutionConfig = {
        task_shape: "single-pass",
        model_mode: "single",
        readiness: "executable",
        topology: { type: "single-session", concurrency: 1 },
        execution: { model: "new-model", effort: "high", context: "main" },
        review: { strategy: "self-check", model: "new-model", effort: "high", context: "main" },
      };

      const rendered = await adapter.renderConfiguration(plan, undefined, workspaceDir);
      await adapter.applyConfiguration(rendered.preview_id, rendered, workspaceDir);

      const result = JSON.parse(await fsp.readFile(projectFile, "utf-8"));
      expect(result.model).toBe("new-model");
      expect(result.project_key).toBe("local-only");
      expect(result.global_only_key).toBeUndefined(); // NOT flattened
      expect(result.theme).toBeUndefined(); // NOT flattened
    });
  });

  describe("Apply Validation: Main Model, Main Variant, Worker Model, and Worker Variant (§75)", () => {
    it("validates main model, main variant, worker model, and worker variant against effective host state", async () => {
      await fsp.writeFile(
        path.join(workspaceDir, "opencode.json"),
        JSON.stringify({
          model: "anthropic/claude-3-7-sonnet",
          variant: "high",
          provider: {
            anthropic: {
              models: {
                "claude-3-7-sonnet": { variants: ["low", "high"] },
                "claude-3-5-haiku": { variants: ["standard", "fast"] },
              },
            },
          },
          agent: {
            "ticket-01": {
              model: "anthropic/claude-3-5-haiku",
              variant: "fast",
            },
          },
        }, null, 2),
        "utf-8"
      );

      const adapter = new OpenCodeAdapter();
      const expectedPlan: ExecutionConfig = {
        task_shape: "decomposed",
        model_mode: "multi",
        readiness: "executable",
        topology: { type: "controller-workers", concurrency: 2 },
        controller: { model: "anthropic/claude-3-7-sonnet", effort: "high", context: "main" },
        work_items: [
          {
            ticket_id: "ticket-01",
            difficulty: "routine",
            model: "anthropic/claude-3-5-haiku",
            effort: "fast",
            context: "w1",
          },
        ],
        review: { strategy: "controller-review", model: "anthropic/claude-3-7-sonnet", effort: "high", context: "main" },
      };

      const validation = await adapter.validateConfiguration(expectedPlan, workspaceDir);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toBeUndefined();
    });

    it("detects drift when main model or main variant does not match effective state", async () => {
      await fsp.writeFile(
        path.join(workspaceDir, "opencode.json"),
        JSON.stringify({
          model: "wrong-model",
          variant: "low",
        }),
        "utf-8"
      );

      const adapter = new OpenCodeAdapter();
      const plan: ExecutionConfig = {
        task_shape: "single-pass",
        model_mode: "single",
        readiness: "executable",
        topology: { type: "single-session", concurrency: 1 },
        execution: { model: "expected-model", effort: "high", context: "main" },
        review: { strategy: "self-check", model: "expected-model", effort: "high", context: "main" },
      };

      const validation = await adapter.validateConfiguration(plan, workspaceDir);
      expect(validation.valid).toBe(false);
      expect(validation.errors).toBeDefined();
      expect(validation.errors?.some((e) => e.includes("Main model mismatch"))).toBe(true);
      expect(validation.errors?.some((e) => e.includes("Main variant mismatch"))).toBe(true);
    });

    it("detects drift when worker model or worker variant does not match effective state", async () => {
      await fsp.writeFile(
        path.join(workspaceDir, "opencode.json"),
        JSON.stringify({
          model: "main-model",
          agent: {
            "ticket-01": {
              model: "wrong-worker-model",
              variant: "wrong-worker-variant",
            },
          },
        }),
        "utf-8"
      );

      const adapter = new OpenCodeAdapter();
      const plan: ExecutionConfig = {
        task_shape: "decomposed",
        model_mode: "multi",
        readiness: "executable",
        topology: { type: "controller-workers", concurrency: 2 },
        controller: { model: "main-model", context: "main" },
        work_items: [
          {
            ticket_id: "ticket-01",
            difficulty: "routine",
            model: "expected-worker-model",
            effort: "expected-variant",
            context: "w1",
          },
        ],
        review: { strategy: "controller-review", model: "main-model", context: "main" },
      };

      const validation = await adapter.validateConfiguration(plan, workspaceDir);
      expect(validation.valid).toBe(false);
      expect(validation.errors).toBeDefined();
      expect(validation.errors?.some((e) => e.includes("model mismatch"))).toBe(true);
      expect(validation.errors?.some((e) => e.includes("variant mismatch"))).toBe(true);
    });
  });

  describe("Scope Fidelity (§13, §66)", () => {
    it("strictly isolates project target from user/global target during companion preview", async () => {
      const adapter = new OpenCodeAdapter();

      // Project scope preview must target workspace
      const projPreview = await adapter.previewCompanionRegistration(workspaceDir, "project");
      expect(projPreview.scope).toBe("project");
      expect(projPreview.target_file).toBe(path.join(workspaceDir, "opencode.json"));
      expect(projPreview.mutation_targets).toEqual([path.join(workspaceDir, "opencode.json")]);

      // User/global scope preview must target globalConfigDir, NOT workspace
      const globalPreview = await adapter.previewCompanionRegistration(workspaceDir, "global");
      expect(globalPreview.scope).toBe("global");
      expect(globalPreview.target_file).toBe(path.join(globalConfigDir, "opencode.json"));
      expect(globalPreview.mutation_targets).toEqual([path.join(globalConfigDir, "opencode.json")]);
    });
  });
});
