import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { CodexAdapter } from "../src/adapters/codex/index.js";
import { OpenCodeAdapter } from "../src/adapters/opencode/index.js";
import { GenericAdapter } from "../src/adapters/generic/index.js";
import { AdapterRegistry } from "../src/adapters/registry.js";
import { ExecutionConfig, AgentProfile } from "../src/profile/schema.js";

describe("Host Adapters (Codex, OpenCode, Generic, Registry)", () => {
  let tempDir: string;
  let workspaceDir: string;

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-config-adapters-test-"));
    workspaceDir = path.join(tempDir, "workspace");
    await fsp.mkdir(workspaceDir, { recursive: true });
  });

  afterEach(async () => {
    if (fs.existsSync(tempDir)) {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  describe("Adapter Contract & Tri-state Capability Verification", () => {
    it("Generic adapter strictly distinguishes capability states and never promotes unknown to available", async () => {
      const adapter = new GenericAdapter();
      const caps = await adapter.inspectCapabilities(workspaceDir);

      expect(caps.host_id).toBe("generic");
      expect(caps.adapter_id).toBe("generic");
      expect(caps.capabilities.subagents.state).toBe("unknown");
      expect(caps.capabilities.threads.state).toBe("unknown");
      expect(caps.capabilities.parallelism.state).toBe("unknown");
      expect(caps.capabilities.model_selection.state).toBe("unknown");
      expect(caps.capabilities.configuration_mutation?.state).toBe("unavailable");

      // Verify no invalid states exist
      const validStates = ["available", "unavailable", "unknown"];
      expect(validStates).toContain(caps.capabilities.subagents.state);
      expect(validStates).toContain(caps.capabilities.threads.state);
      expect(validStates).toContain(caps.capabilities.parallelism.state);
      expect(validStates).toContain(caps.capabilities.model_selection.state);
      expect(validStates).toContain(caps.capabilities.configuration_mutation?.state);
    });

    it("Codex adapter reports available capabilities backed by evidence", async () => {
      const adapter = new CodexAdapter();
      const caps = await adapter.inspectCapabilities(workspaceDir);

      expect(caps.host_id).toBe("codex");
      expect(caps.capabilities.subagents.state).toBe("available");
      expect(caps.capabilities.threads.state).toBe("available");
      expect(caps.capabilities.parallelism.state).toBe("available");
      expect(caps.capabilities.model_selection.state).toBe("available");
      expect(caps.capabilities.per_agent_model_selection?.state).toBe("available");
      expect(caps.capabilities.configuration_mutation?.state).toBe("available");
      expect(caps.capabilities.configuration_mutation?.supports_native_files).toBe(true);
      expect(caps.supported_effort_values).toEqual(["low", "medium", "high", "max"]);
    });

    it("OpenCode adapter reports available capabilities backed by evidence", async () => {
      const adapter = new OpenCodeAdapter();
      const caps = await adapter.inspectCapabilities(workspaceDir);

      expect(caps.host_id).toBe("opencode");
      expect(caps.capabilities.subagents.state).toBe("available");
      expect(caps.capabilities.threads.state).toBe("available");
      expect(caps.capabilities.parallelism.state).toBe("available");
      expect(caps.capabilities.model_selection.state).toBe("available");
      expect(caps.capabilities.per_agent_model_selection?.state).toBe("available");
      expect(caps.capabilities.configuration_mutation?.state).toBe("available");
      expect(caps.capabilities.configuration_mutation?.supports_native_files).toBe(true);
      expect(caps.supported_effort_values).toEqual(["low", "medium", "high"]);
    });
  });

  describe("Codex Adapter (Isolated)", () => {
    const singlePassPlan: ExecutionConfig = {
      task_shape: "single-pass",
      model_mode: "single",
      readiness: "executable",
      topology: {
        type: "single-session",
        concurrency: 1,
      },
      execution: {
        model: "gpt-5.6-sol",
        effort: "high",
        effort_policy: "highest-supported",
        context: "current-session",
      },
      review: {
        strategy: "self-check",
        model: "gpt-5.6-sol",
        effort: "high",
        context: "current-session",
      },
    };

    const decomposedPlan: ExecutionConfig = {
      task_shape: "decomposed",
      model_mode: "multi",
      readiness: "executable",
      topology: {
        type: "controller-workers",
        concurrency: 2,
        fresh_contexts: true,
        subagent_contexts: true,
      },
      controller: {
        model: "gpt-5.6-sol",
        effort: "high",
        context: "main-session",
      },
      work_items: [
        {
          ticket_id: "01-init",
          difficulty: "routine",
          model: "gpt-5.6-luna",
          effort: "low",
          context: "worker-1",
        },
        {
          ticket_id: "02-core",
          difficulty: "demanding",
          model: "gpt-5.6-terra",
          effort: "high",
          context: "worker-2",
        },
      ],
      review: {
        strategy: "independent-review",
        model: "gpt-5.6-sol",
        effort: "high",
        context: "fresh-session",
      },
    };

    it("identifies Codex host when .codex directory exists in workspace", async () => {
      const adapter = new CodexAdapter();
      expect(await adapter.identifyHost(workspaceDir)).toBe(false);

      await fsp.mkdir(path.join(workspaceDir, ".codex"), { recursive: true });
      expect(await adapter.identifyHost(workspaceDir)).toBe(true);
    });

    it("renders, applies, and validates single-pass config to isolated workspace", async () => {
      const adapter = new CodexAdapter();
      const rendered = await adapter.renderConfiguration(singlePassPlan, undefined, workspaceDir);

      expect(rendered.preview_id).toBeDefined();
      expect(rendered.mutation_targets).toHaveLength(1);
      expect(rendered.mutation_targets[0]).toBe(path.join(workspaceDir, ".codex", "config.toml"));
      expect(rendered.diff).toContain("+model = \"gpt-5.6-sol\"");
      expect(rendered.diff).toContain("+model_reasoning_effort = \"high\"");

      // Apply
      const applyResult = await adapter.applyConfiguration(rendered.preview_id, rendered, workspaceDir);
      expect(applyResult.success).toBe(true);
      expect(applyResult.applied_targets).toEqual([path.join(workspaceDir, ".codex", "config.toml")]);

      // Verify file was written
      const configFile = path.join(workspaceDir, ".codex", "config.toml");
      expect(fs.existsSync(configFile)).toBe(true);
      const content = await fsp.readFile(configFile, "utf-8");
      expect(content).toContain('model = "gpt-5.6-sol"');
      expect(content).toContain('model_reasoning_effort = "high"');

      // Validate
      const validation = await adapter.validateConfiguration(singlePassPlan, workspaceDir);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toBeUndefined();
    });

    it("renders, applies, and validates decomposed multi-agent config with subagent toml files", async () => {
      const adapter = new CodexAdapter();
      const rendered = await adapter.renderConfiguration(decomposedPlan, undefined, workspaceDir);

      // 1 main config + 2 agent configs = 3 targets
      expect(rendered.mutation_targets).toHaveLength(3);
      expect(rendered.mutation_targets).toContain(path.join(workspaceDir, ".codex", "config.toml"));
      expect(rendered.mutation_targets).toContain(path.join(workspaceDir, ".codex", "agents", "01-init.toml"));
      expect(rendered.mutation_targets).toContain(path.join(workspaceDir, ".codex", "agents", "02-core.toml"));

      // Apply
      const applyResult = await adapter.applyConfiguration(rendered.preview_id, rendered, workspaceDir);
      expect(applyResult.success).toBe(true);
      expect(applyResult.applied_targets).toHaveLength(3);

      // Validate
      const validation = await adapter.validateConfiguration(decomposedPlan, workspaceDir);
      expect(validation.valid).toBe(true);

      // Detect drift when agent model changes
      const agentFile = path.join(workspaceDir, ".codex", "agents", "01-init.toml");
      await fsp.writeFile(agentFile, 'name = "01-init"\nmodel = "wrong-model"\n', "utf-8");

      const driftValidation = await adapter.validateConfiguration(decomposedPlan, workspaceDir);
      expect(driftValidation.valid).toBe(false);
      expect(driftValidation.errors?.length).toBeGreaterThan(0);
      expect(driftValidation.errors![0]).toContain("model mismatch");

      // Detect drift when agent file is deleted
      await fsp.unlink(agentFile);
      const missingValidation = await adapter.validateConfiguration(decomposedPlan, workspaceDir);
      expect(missingValidation.valid).toBe(false);
      expect(missingValidation.errors![0]).toContain("Missing work item agent config");
    });
  });

  describe("OpenCode Adapter (Isolated)", () => {
    const singlePassPlan: ExecutionConfig = {
      task_shape: "single-pass",
      model_mode: "single",
      readiness: "executable",
      topology: {
        type: "single-session",
        concurrency: 1,
      },
      execution: {
        model: "cpa-gui/gemini-3.8-flash-high",
        effort: "high",
        effort_policy: "highest-supported",
        context: "current-session",
      },
      review: {
        strategy: "self-check",
        model: "cpa-gui/gemini-3.8-flash-high",
        effort: "high",
        context: "current-session",
      },
    };

    const decomposedPlan: ExecutionConfig = {
      task_shape: "decomposed",
      model_mode: "multi",
      readiness: "executable",
      topology: {
        type: "controller-workers",
        concurrency: 2,
        fresh_contexts: true,
        subagent_contexts: true,
      },
      controller: {
        model: "cpa-gui/gemini-3.8-flash-high",
        effort: "high",
        context: "main-session",
      },
      work_items: [
        {
          ticket_id: "worker-task-1",
          difficulty: "routine",
          model: "cpa-gui/gemini-3.1-flash-lite",
          effort: "low",
          context: "worker-1",
        },
      ],
      review: {
        strategy: "independent-review",
        model: "cpa-gui/claude-sonnet-4-6",
        effort: "high",
        context: "fresh-session",
      },
    };

    it("identifies OpenCode host when opencode.json exists in workspace", async () => {
      const adapter = new OpenCodeAdapter();
      // Ensure isolated test dir without opencode.json doesn't identify as local workspace
      const emptyDir = path.join(tempDir, "empty-dir");
      await fsp.mkdir(emptyDir, { recursive: true });

      await fsp.writeFile(path.join(workspaceDir, "opencode.json"), "{}", "utf-8");
      expect(await adapter.identifyHost(workspaceDir)).toBe(true);
    });

    it("inspects models from workspace opencode.jsonc with providers and comments", async () => {
      const configContent = `// OpenCode workspace configuration
{
  "model": "custom-provider/custom-default-model",
  "provider": {
    "my-provider": {
      "models": {
        "model-a": { "name": "Model A" },
        "model-b": { "name": "Model B" }
      }
    }
  }
}
`;
      await fsp.writeFile(path.join(workspaceDir, "opencode.jsonc"), configContent, "utf-8");

      const adapter = new OpenCodeAdapter();
      const models = await adapter.inspectModels(workspaceDir);

      expect(models.some((m) => m.id === "my-provider/model-a")).toBe(true);
      expect(models.some((m) => m.id === "my-provider/model-b")).toBe(true);
      expect(models.some((m) => m.id === "custom-provider/custom-default-model")).toBe(true);
    });

    it("renders, applies, and validates single-pass OpenCode configuration", async () => {
      const adapter = new OpenCodeAdapter();
      const rendered = await adapter.renderConfiguration(singlePassPlan, undefined, workspaceDir);

      expect(rendered.mutation_targets).toHaveLength(1);
      expect(rendered.mutation_targets[0]).toBe(path.join(workspaceDir, "opencode.json"));
      expect(rendered.diff).toContain('"model": "cpa-gui/gemini-3.8-flash-high"');

      // Apply
      const applyResult = await adapter.applyConfiguration(rendered.preview_id, rendered, workspaceDir);
      expect(applyResult.success).toBe(true);

      const targetPath = path.join(workspaceDir, "opencode.json");
      expect(fs.existsSync(targetPath)).toBe(true);
      const content = JSON.parse(await fsp.readFile(targetPath, "utf-8"));
      expect(content.model).toBe("cpa-gui/gemini-3.8-flash-high");

      // Validate
      const validation = await adapter.validateConfiguration(singlePassPlan, workspaceDir);
      expect(validation.valid).toBe(true);
    });

    it("renders, applies, and validates decomposed OpenCode configuration with agents map", async () => {
      const adapter = new OpenCodeAdapter();
      const rendered = await adapter.renderConfiguration(decomposedPlan, undefined, workspaceDir);

      // Apply
      const applyResult = await adapter.applyConfiguration(rendered.preview_id, rendered, workspaceDir);
      expect(applyResult.success).toBe(true);

      const targetPath = path.join(workspaceDir, "opencode.json");
      const content = JSON.parse(await fsp.readFile(targetPath, "utf-8"));
      expect(content.agent["worker-task-1"]).toBeDefined();
      expect(content.agent["worker-task-1"].model).toBe("cpa-gui/gemini-3.1-flash-lite");

      // Validate
      const validation = await adapter.validateConfiguration(decomposedPlan, workspaceDir);
      expect(validation.valid).toBe(true);

      // Test drift detection
      content.agent["worker-task-1"].model = "tampered-model";
      await fsp.writeFile(targetPath, JSON.stringify(content, null, 2), "utf-8");

      const driftValidation = await adapter.validateConfiguration(decomposedPlan, workspaceDir);
      expect(driftValidation.valid).toBe(false);
      expect(driftValidation.errors![0]).toContain("model mismatch");
    });

    it("preserves non-conflicting keys in existing opencode.json during render & apply", async () => {
      const adapter = new OpenCodeAdapter();
      const existingConfig = {
        $schema: "https://opencode.ai/config.json",
        theme: "dark",
        mcp: {
          serverA: { command: "node" },
        },
        model: "old-model",
      };
      const targetPath = path.join(workspaceDir, "opencode.json");
      await fsp.writeFile(targetPath, JSON.stringify(existingConfig, null, 2), "utf-8");

      const rendered = await adapter.renderConfiguration(singlePassPlan, undefined, workspaceDir);
      await adapter.applyConfiguration(rendered.preview_id, rendered, workspaceDir);

      const content = JSON.parse(await fsp.readFile(targetPath, "utf-8"));
      expect(content.theme).toBe("dark");
      expect(content.mcp).toEqual({ serverA: { command: "node" } });
      expect(content.model).toBe("cpa-gui/gemini-3.8-flash-high");
    });
  });

  describe("Generic Adapter (Plan-Only)", () => {
    it("never mutates files and returns empty mutation targets for single-pass plan", async () => {
      const adapter = new GenericAdapter();
      const plan: ExecutionConfig = {
        task_shape: "single-pass",
        model_mode: "single",
        readiness: "executable",
        topology: { type: "single-session", concurrency: 1 },
        execution: { model: "any-model", effort: "default", context: "main" },
        review: { strategy: "self-check", model: "any-model", effort: "default", context: "main" },
      };

      const rendered = await adapter.renderConfiguration(plan, undefined, workspaceDir);
      expect(rendered.mutation_targets).toHaveLength(0);
      expect(rendered.diff).toContain("Plan-Only");

      const apply = await adapter.applyConfiguration(rendered.preview_id, rendered, workspaceDir);
      expect(apply.success).toBe(true);
      expect(apply.applied_targets).toHaveLength(0);

      const validation = await adapter.validateConfiguration(plan, workspaceDir);
      expect(validation.valid).toBe(true);
    });

    it("never mutates files and returns empty mutation targets for decomposed plan", async () => {
      const adapter = new GenericAdapter();
      const decomposedPlan: ExecutionConfig = {
        task_shape: "decomposed",
        model_mode: "multi",
        readiness: "executable",
        topology: { type: "controller-workers", concurrency: 2 },
        controller: { model: "ctrl-model", effort: "default", context: "main" },
        work_items: [
          {
            ticket_id: "task-1",
            difficulty: "routine",
            model: "worker-model",
            effort: "default",
            context: "w1",
          },
        ],
        review: { strategy: "controller-review", model: "ctrl-model", effort: "default", context: "main" },
      };

      const rendered = await adapter.renderConfiguration(decomposedPlan, undefined, workspaceDir);
      expect(rendered.mutation_targets).toHaveLength(0);
      expect(rendered.diff).toContain("Plan-Only Configuration");
      expect(rendered.diff).toContain("task-1");

      const apply = await adapter.applyConfiguration(rendered.preview_id, rendered, workspaceDir);
      expect(apply.success).toBe(true);
      expect(apply.applied_targets).toHaveLength(0);

      const validation = await adapter.validateConfiguration(decomposedPlan, workspaceDir);
      expect(validation.valid).toBe(true);
    });
  });

  describe("Adapter Registry Resolution", () => {
    it("registers Codex, OpenCode, and Generic adapters by default", () => {
      const registry = new AdapterRegistry();
      const adapters = registry.listAdapters();
      const ids = adapters.map((a) => a.id);

      expect(ids).toContain("codex");
      expect(ids).toContain("opencode");
      expect(ids).toContain("generic");
    });

    it("resolves specific adapter when host_id is supplied", async () => {
      const registry = new AdapterRegistry();
      const codex = await registry.resolveAdapter(workspaceDir, "codex");
      expect(codex.id).toBe("codex");

      const opencode = await registry.resolveAdapter(workspaceDir, "opencode");
      expect(opencode.id).toBe("opencode");

      const generic = await registry.resolveAdapter(workspaceDir, "generic");
      expect(generic.id).toBe("generic");
    });

    it("resolves OpenCode adapter when workspace has opencode.json", async () => {
      const registry = new AdapterRegistry();
      await fsp.writeFile(path.join(workspaceDir, "opencode.json"), "{}", "utf-8");

      const resolved = await registry.resolveAdapter(workspaceDir);
      expect(resolved.id).toBe("opencode");
    });

    it("resolves Codex adapter when workspace has .codex directory", async () => {
      const registry = new AdapterRegistry();
      await fsp.mkdir(path.join(workspaceDir, ".codex"), { recursive: true });

      const resolved = await registry.resolveAdapter(workspaceDir);
      expect(resolved.id).toBe("codex");
    });
  });
});
