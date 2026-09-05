import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { CodexAdapter } from "../src/adapters/codex/index.js";
import { OpenCodeAdapter } from "../src/adapters/opencode/index.js";
import { GenericAdapter } from "../src/adapters/generic/index.js";
import { AdapterRegistry, AmbiguousHostError } from "../src/adapters/registry.js";
import { resolveHostReasoningPolicy } from "../src/adapters/contract.js";
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

    it("Codex adapter reports unknown for unconfirmed concurrency, effort, and unevidenced capabilities", async () => {
      const adapter = new CodexAdapter();
      const caps = await adapter.inspectCapabilities(workspaceDir);

      expect(caps.host_id).toBe("codex");
      expect(caps.capabilities.subagents.state).toBe("unknown");
      expect(caps.capabilities.threads.state).toBe("unknown");
      expect(caps.capabilities.parallelism.state).toBe("unknown");
      expect(caps.capabilities.concurrency?.state).toBe("unknown");
      expect(caps.capabilities.model_selection.state).toBe("unknown");
      expect(caps.capabilities.per_agent_model_selection?.state).toBe("unknown");
      expect(caps.capabilities.configuration_mutation?.state).toBe("available");
      expect(caps.capabilities.configuration_mutation?.supports_native_files).toBe(true);
      expect(caps.supported_effort_values).toEqual([]);
      expect(caps.capabilities.reasoning?.state).toBe("unknown");
    });

    it("Codex adapter reports available for subagents, threads, and models when evidenced", async () => {
      const codexDir = path.join(workspaceDir, ".codex");
      await fsp.mkdir(path.join(codexDir, "agents"), { recursive: true });
      await fsp.mkdir(path.join(codexDir, "sessions"), { recursive: true });
      await fsp.writeFile(
        path.join(codexDir, "config.toml"),
        'model = "gpt-4o"\n',
        "utf-8"
      );

      const adapter = new CodexAdapter();
      const caps = await adapter.inspectCapabilities(workspaceDir);

      expect(caps.capabilities.subagents.state).toBe("available");
      expect(caps.capabilities.threads.state).toBe("available");
      expect(caps.capabilities.model_selection.state).toBe("available");
      expect(caps.capabilities.per_agent_model_selection?.state).toBe("available");
    });

    it("OpenCode adapter reports unknown for unconfirmed concurrency and effort, and available for evidenced capabilities", async () => {
      const adapter = new OpenCodeAdapter();
      const caps = await adapter.inspectCapabilities(workspaceDir);

      expect(caps.host_id).toBe("opencode");
      expect(caps.capabilities.subagents.state).toBe("available");
      expect(caps.capabilities.threads.state).toBe("available");
      expect(caps.capabilities.parallelism.state).toBe("unknown");
      expect(caps.capabilities.concurrency?.state).toBe("unknown");
      expect(caps.capabilities.model_selection.state).toBe("available");
      expect(caps.capabilities.per_agent_model_selection?.state).toBe("available");
      expect(caps.capabilities.configuration_mutation?.state).toBe("available");
      expect(caps.capabilities.configuration_mutation?.supports_native_files).toBe(true);
      expect(caps.supported_effort_values).toEqual([]);
      expect(caps.capabilities.reasoning?.state).toBe("unknown");
    });

    it("Codex adapter reports available parallelism and reasoning when evidenced in host config", async () => {
      const codexDir = path.join(workspaceDir, ".codex");
      await fsp.mkdir(codexDir, { recursive: true });
      await fsp.writeFile(
        path.join(codexDir, "config.toml"),
        'max_concurrency = 4\nsupported_effort_values = ["low", "medium", "high"]\n',
        "utf-8"
      );

      const adapter = new CodexAdapter();
      const caps = await adapter.inspectCapabilities(workspaceDir);

      expect(caps.capabilities.parallelism.state).toBe("available");
      expect(caps.capabilities.concurrency?.state).toBe("available");
      expect(caps.capabilities.concurrency?.max_concurrency).toBe(4);
      expect(caps.capabilities.reasoning?.state).toBe("available");
      expect(caps.supported_effort_values).toEqual(["low", "medium", "high"]);
    });

    it("OpenCode adapter reports available parallelism and reasoning when evidenced in host config", async () => {
      await fsp.writeFile(
        path.join(workspaceDir, "opencode.json"),
        JSON.stringify({
          max_concurrency: 6,
          provider: {
            "test-prov": {
              models: {
                "model-1": { variants: ["fast", "deep"] },
              },
            },
          },
        }),
        "utf-8"
      );

      const adapter = new OpenCodeAdapter();
      const caps = await adapter.inspectCapabilities(workspaceDir);

      expect(caps.capabilities.parallelism.state).toBe("available");
      expect(caps.capabilities.concurrency?.state).toBe("available");
      expect(caps.capabilities.concurrency?.max_concurrency).toBe(6);
      expect(caps.capabilities.reasoning?.state).toBe("available");
      expect(caps.supported_effort_values).toEqual(["fast", "deep"]);
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
    it("registers exactly 9 native adapters and 1 fallback adapter by default", () => {
      const registry = new AdapterRegistry();
      const adapters = registry.listAdapters();
      const ids = adapters.map((a) => a.id);

      // Verify exact count: 9 native adapters + 1 fallback generic adapter
      const nativeAdapters = adapters.filter((a) => a.id !== "generic");
      expect(nativeAdapters.length).toBe(9);
      expect(adapters.length).toBe(10);

      // Verify the exact 9 native adapters
      expect(ids).toContain("codex");
      expect(ids).toContain("opencode");
      expect(ids).toContain("claude-code");
      expect(ids).toContain("gemini-cli");
      expect(ids).toContain("cursor");
      expect(ids).toContain("dsh");
      expect(ids).toContain("grok-build");
      expect(ids).toContain("zcode");
      expect(ids).toContain("hermes");

      // Verify generic fallback
      expect(ids).toContain("generic");

      // Verify all deleted non-v1 adapters are purged from registry
      expect(ids).not.toContain("copilot-cli");
      expect(ids).not.toContain("kiro");
      expect(ids).not.toContain("zed");
      expect(ids).not.toContain("amp");
      expect(ids).not.toContain("windsurf");
      expect(ids).not.toContain("cline");
      expect(ids).not.toContain("roo-code");
      // Verify Pi is deferred and NOT in native registry
      expect(ids).not.toContain("pi");
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

    it("resolves Gemini CLI adapter when workspace has .gemini directory", async () => {
      const registry = new AdapterRegistry();
      await fsp.mkdir(path.join(workspaceDir, ".gemini"), { recursive: true });

      const resolved = await registry.resolveAdapter(workspaceDir);
      expect(resolved.id).toBe("gemini-cli");
    });

    it("resolves Cursor adapter when workspace has .cursor directory", async () => {
      const registry = new AdapterRegistry();
      await fsp.mkdir(path.join(workspaceDir, ".cursor"), { recursive: true });

      const resolved = await registry.resolveAdapter(workspaceDir);
      expect(resolved.id).toBe("cursor");
    });

    it("resolves DSH adapter when workspace has dsh.config.json file", async () => {
      const registry = new AdapterRegistry();
      await fsp.writeFile(path.join(workspaceDir, "dsh.config.json"), "{}", "utf-8");

      const resolved = await registry.resolveAdapter(workspaceDir);
      expect(resolved.id).toBe("dsh");
    });

    it("resolves Grok Build adapter when workspace has .grok directory", async () => {
      const registry = new AdapterRegistry();
      await fsp.mkdir(path.join(workspaceDir, ".grok"), { recursive: true });

      const resolved = await registry.resolveAdapter(workspaceDir);
      expect(resolved.id).toBe("grok-build");
    });
  });

  describe("Adapter Contract v1: Version Inspection & Fail-Closed Compatibility (§21, §22)", () => {
    it("reports unknown-version and enforces fail_closed_for_mutation when version is unevidenced", async () => {
      const codex = new CodexAdapter();
      const opencode = new OpenCodeAdapter();

      const codexVer = await codex.inspectVersion(workspaceDir);
      expect(codexVer.compatibility).toBe("unknown-version");
      expect(codexVer.fail_closed_for_mutation).toBe(true);

      const opencodeVer = await opencode.inspectVersion(workspaceDir);
      expect(opencodeVer.compatibility).toBe("unknown-version");
      expect(opencodeVer.fail_closed_for_mutation).toBe(true);
    });

    it("classifies version compatibility and relaxes fail-closed mutation for supported versions", async () => {
      const codex = new CodexAdapter();
      const opencode = new OpenCodeAdapter();

      const origCodexVer = process.env.CODEX_VERSION;
      const origOpencodeVer = process.env.OPENCODE_VERSION;
      try {
        process.env.CODEX_VERSION = "0.5.2";
        process.env.OPENCODE_VERSION = "1.2.0";

        const codexVer = await codex.inspectVersion(workspaceDir);
        expect(codexVer.version).toBe("0.5.2");
        expect(codexVer.compatibility).toBe("supported");
        expect(codexVer.fail_closed_for_mutation).toBe(false);

        const opencodeVer = await opencode.inspectVersion(workspaceDir);
        expect(opencodeVer.version).toBe("1.2.0");
        expect(opencodeVer.compatibility).toBe("supported");
        expect(opencodeVer.fail_closed_for_mutation).toBe(false);
      } finally {
        if (origCodexVer !== undefined) {
          process.env.CODEX_VERSION = origCodexVer;
        } else {
          delete process.env.CODEX_VERSION;
        }
        if (origOpencodeVer !== undefined) {
          process.env.OPENCODE_VERSION = origOpencodeVer;
        } else {
          delete process.env.OPENCODE_VERSION;
        }
      }
    });

    it("enforces fail-closed mutation for incompatible versions while allowing read-only inspection", async () => {
      const codex = new CodexAdapter();
      const origCodexVer = process.env.CODEX_VERSION;
      try {
        process.env.CODEX_VERSION = "incompatible";
        const ver = await codex.inspectVersion(workspaceDir);
        expect(ver.compatibility).toBe("incompatible");
        expect(ver.fail_closed_for_mutation).toBe(true);

        // Read-only inspection still works
        const caps = await codex.inspectCapabilities(workspaceDir);
        expect(caps.host_id).toBe("codex");
      } finally {
        if (origCodexVer !== undefined) {
          process.env.CODEX_VERSION = origCodexVer;
        } else {
          delete process.env.CODEX_VERSION;
        }
      }
    });

    it("Generic adapter reports supported compatibility but enforces fail_closed_for_mutation", async () => {
      const generic = new GenericAdapter();
      const ver = await generic.inspectVersion(workspaceDir);
      expect(ver.compatibility).toBe("supported");
      expect(ver.fail_closed_for_mutation).toBe(true);
    });
  });

  describe("Adapter Contract v1: Reasoning Options & Abstract Policy Resolution (§11, §12)", () => {
    it("reports host-native reasoning field without hardcoding effort globally", async () => {
      const codex = new CodexAdapter();
      const opencode = new OpenCodeAdapter();
      const generic = new GenericAdapter();

      const codexOptions = await codex.inspectReasoningOptions(workspaceDir);
      expect(codexOptions.native_field).toBe("model_reasoning_effort");

      const opencodeOptions = await opencode.inspectReasoningOptions(workspaceDir);
      expect(opencodeOptions.native_field).toBe("variant");

      const genericOptions = await generic.inspectReasoningOptions(workspaceDir);
      expect(genericOptions.native_field).toBe("reasoning");
      expect(genericOptions.supported_values).toEqual([]);
    });

    it("resolves abstract reasoning policies to host-native representations for Codex when evidenced", async () => {
      const codexDir = path.join(workspaceDir, ".codex");
      await fsp.mkdir(codexDir, { recursive: true });
      await fsp.writeFile(
        path.join(codexDir, "config.toml"),
        'model = "o3-mini"\nmodel_reasoning_effort = "high"\n',
        "utf-8"
      );

      const codex = new CodexAdapter();

      const high = await codex.resolveReasoningPolicy("highest-supported", undefined, workspaceDir);
      expect(high).toEqual({
        host_field: "model_reasoning_effort",
        host_value: "high",
      });

      const low = await codex.resolveReasoningPolicy("lowest-sufficient", undefined, workspaceDir);
      expect(low).toEqual({
        host_field: "model_reasoning_effort",
        host_value: "high",
      });

      const configured = await codex.resolveReasoningPolicy("configured", undefined, workspaceDir);
      expect(configured).toEqual({
        host_field: "model_reasoning_effort",
        host_value: "high",
      });
    });

    it("resolves abstract reasoning policies to variants for OpenCode models", async () => {
      const opencode = new OpenCodeAdapter();
      await fsp.writeFile(
        path.join(workspaceDir, "opencode.json"),
        JSON.stringify({
          model: "openai/o3-mini",
          provider: {
            openai: {
              models: {
                "o3-mini": {
                  variants: ["low", "medium", "high", "max"],
                },
              },
            },
          },
        }),
        "utf-8"
      );

      const high = await opencode.resolveReasoningPolicy(
        "highest-supported",
        "openai/o3-mini",
        workspaceDir
      );
      expect(high).toEqual({
        host_field: "variant",
        host_value: "max",
      });

      const low = await opencode.resolveReasoningPolicy(
        "lowest-sufficient",
        "openai/o3-mini",
        workspaceDir
      );
      expect(low).toEqual({
        host_field: "variant",
        host_value: "low",
      });
    });

    it("resolveHostReasoningPolicy helper functions host-neutrally across all adapters", async () => {
      const codexDir = path.join(workspaceDir, ".codex");
      await fsp.mkdir(codexDir, { recursive: true });
      await fsp.writeFile(
        path.join(codexDir, "config.toml"),
        'model = "o3-mini"\nmodel_reasoning_effort = "high"\n',
        "utf-8"
      );

      const codex = new CodexAdapter();
      const generic = new GenericAdapter();

      const codexResolved = await resolveHostReasoningPolicy(
        codex,
        "highest-supported",
        undefined,
        workspaceDir
      );
      expect(codexResolved?.host_field).toBe("model_reasoning_effort");
      expect(codexResolved?.host_value).toBe("high");

      const genericResolved = await resolveHostReasoningPolicy(
        generic,
        "highest-supported",
        undefined,
        workspaceDir
      );
      expect(genericResolved).toBeUndefined();
    });
  });

  describe("Adapter Contract v1: Execution Topology Capabilities (§19)", () => {
    it("reports authentic execution topology capabilities for Codex when evidenced", async () => {
      const codexDir = path.join(workspaceDir, ".codex");
      await fsp.mkdir(path.join(codexDir, "agents"), { recursive: true });

      const codex = new CodexAdapter();
      const topology = await codex.inspectExecutionTopologyCapabilities(workspaceDir);

      expect(topology.supports_single_session).toBe(true);
      expect(topology.supports_subagents).toBe(true);
      expect(topology.supports_multi_agent).toBe(true);
      expect(topology.scopes).toContain("per-agent");
    });

    it("reports subagents as unsupported in topology when unevidenced for Codex", async () => {
      const codex = new CodexAdapter();
      const topology = await codex.inspectExecutionTopologyCapabilities(workspaceDir);

      expect(topology.supports_single_session).toBe(true);
      expect(topology.supports_subagents).toBe(false);
      expect(topology.supports_multi_agent).toBe(false);
      expect(topology.scopes).toEqual(["current-session", "new-session"]);
    });

    it("reports authentic execution topology capabilities for OpenCode", async () => {
      const opencode = new OpenCodeAdapter();
      const topology = await opencode.inspectExecutionTopologyCapabilities(workspaceDir);

      expect(topology.supports_single_session).toBe(true);
      expect(topology.supports_subagents).toBe(true);
      expect(topology.supports_multi_agent).toBe(true);
      expect(topology.scopes).toContain("per-agent");
    });

    it("reports plan-only single-session execution topology for Generic adapter", async () => {
      const generic = new GenericAdapter();
      const topology = await generic.inspectExecutionTopologyCapabilities(workspaceDir);

      expect(topology.supports_single_session).toBe(true);
      expect(topology.supports_subagents).toBe(false);
      expect(topology.supports_multi_agent).toBe(false);
      expect(topology.supports_parallel_execution).toBe(false);
      expect(topology.scopes).toEqual(["current-session"]);
    });
  });

  describe("Adapter Contract v1: Companion Registration Lifecycle & Safe Mutation (§19, §71)", () => {
    it("manages Codex companion registration preview, apply, and validate lifecycle", async () => {
      const codex = new CodexAdapter();

      // Initial status: not registered
      const initialStatus = await codex.inspectCompanionRegistration(workspaceDir);
      expect(initialStatus.registered).toBe(false);

      // Preview: generates diff and preview_hash
      const preview = await codex.previewCompanionRegistration(workspaceDir);
      expect(preview.supported).toBe(true);
      expect(preview.preview_hash).toBeDefined();
      expect(preview.diff).toContain("agent-config");
      expect(preview.mutation_targets).toHaveLength(1);

      // Apply: creates target file
      const applyResult = await codex.applyCompanionRegistration(
        preview.preview_hash!,
        workspaceDir
      );
      expect(applyResult.success).toBe(true);
      expect(applyResult.applied_targets).toHaveLength(1);

      // Validate: confirmed registered
      const validation = await codex.validateCompanionRegistration(workspaceDir);
      expect(validation.valid).toBe(true);

      const postStatus = await codex.inspectCompanionRegistration(workspaceDir);
      expect(postStatus.registered).toBe(true);
    });

    it("manages OpenCode companion registration preview, apply, and validate lifecycle", async () => {
      const opencode = new OpenCodeAdapter();
      await fsp.writeFile(
        path.join(workspaceDir, "opencode.json"),
        JSON.stringify({ model: "test-model" }),
        "utf-8"
      );

      const initialStatus = await opencode.inspectCompanionRegistration(workspaceDir);
      expect(initialStatus.registered).toBe(false);

      const preview = await opencode.previewCompanionRegistration(workspaceDir);
      expect(preview.supported).toBe(true);
      expect(preview.preview_hash).toBeDefined();
      expect(preview.diff).toContain("agent-config");

      const applyResult = await opencode.applyCompanionRegistration(
        preview.preview_hash!,
        workspaceDir
      );
      expect(applyResult.success).toBe(true);

      const validation = await opencode.validateCompanionRegistration(workspaceDir);
      expect(validation.valid).toBe(true);
    });

    it("explicitly rejects companion registration mutation on Generic adapter", async () => {
      const generic = new GenericAdapter();

      const preview = await generic.previewCompanionRegistration(workspaceDir);
      expect(preview.supported).toBe(false);
      expect(preview.mutation_targets).toHaveLength(0);
      expect(preview.error).toBeDefined();

      const applyResult = await generic.applyCompanionRegistration("hash-123", workspaceDir);
      expect(applyResult.success).toBe(false);
      expect(applyResult.error).toBeDefined();

      const validation = await generic.validateCompanionRegistration(workspaceDir);
      expect(validation.valid).toBe(false);
    });
  });

  describe("Host Identification & Disambiguation (§20)", () => {
    it("detectAllCandidates enumerates all matching candidates without fallback", async () => {
      const registry = new AdapterRegistry();

      // Empty workspace: 0 candidates
      const emptyCandidates = await registry.detectAllCandidates(workspaceDir);
      expect(emptyCandidates).toEqual([]);

      // Workspace with both .codex and opencode.json
      await fsp.mkdir(path.join(workspaceDir, ".codex"), { recursive: true });
      await fsp.writeFile(path.join(workspaceDir, "opencode.json"), "{}", "utf-8");

      const multiCandidates = await registry.detectAllCandidates(workspaceDir);
      expect(multiCandidates).toContain("codex");
      expect(multiCandidates).toContain("opencode");
    });

    it("disambiguates multiple installed harnesses using active runtime context (environment)", async () => {
      const registry = new AdapterRegistry();

      // Setup workspace with both harnesses installed
      await fsp.mkdir(path.join(workspaceDir, ".codex"), { recursive: true });
      await fsp.writeFile(path.join(workspaceDir, "opencode.json"), "{}", "utf-8");

      const origOpenCodeSession = process.env.OPENCODE_SESSION_ID;
      try {
        process.env.OPENCODE_SESSION_ID = "active-opencode-session";

        const resolved = await registry.resolveAdapter(workspaceDir);
        expect(resolved.id).toBe("opencode");
      } finally {
        if (origOpenCodeSession !== undefined) {
          process.env.OPENCODE_SESSION_ID = origOpenCodeSession;
        } else {
          delete process.env.OPENCODE_SESSION_ID;
        }
      }
    });

    it("disambiguates multiple installed harnesses using disambiguation handler callback", async () => {
      const registry = new AdapterRegistry();

      await fsp.mkdir(path.join(workspaceDir, ".codex"), { recursive: true });
      await fsp.writeFile(path.join(workspaceDir, "opencode.json"), "{}", "utf-8");

      let promptCandidates: string[] = [];
      const resolved = await registry.resolveAdapter(workspaceDir, undefined, {
        disambiguate: async (candidates) => {
          promptCandidates = candidates;
          return "codex";
        },
      });

      expect(promptCandidates).toContain("codex");
      expect(promptCandidates).toContain("opencode");
      expect(resolved.id).toBe("codex");
    });

    it("throws AmbiguousHostError when multiple harnesses match and no runtime or handler resolves it", async () => {
      const registry = new AdapterRegistry();

      await fsp.mkdir(path.join(workspaceDir, ".codex"), { recursive: true });
      await fsp.writeFile(path.join(workspaceDir, "opencode.json"), "{}", "utf-8");

      await expect(registry.resolveAdapter(workspaceDir)).rejects.toThrow(AmbiguousHostError);
    });

    it("resolves specific host_id directly even when multiple harnesses are installed", async () => {
      const registry = new AdapterRegistry();

      await fsp.mkdir(path.join(workspaceDir, ".codex"), { recursive: true });
      await fsp.writeFile(path.join(workspaceDir, "opencode.json"), "{}", "utf-8");

      const resolved = await registry.resolveAdapter(workspaceDir, "opencode");
      expect(resolved.id).toBe("opencode");
    });
  });
});
