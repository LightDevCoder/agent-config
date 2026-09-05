import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { GrokBuildAdapter, parseToml } from "../../src/adapters/grok-build/index.js";
import { ExecutionConfig } from "../../src/profile/schema.js";
import { createMockSubprocessRunner, MockSubprocessRunner } from "../harness/mock-runner.js";

describe("Grok Build Native Adapter Tests (§44, §45, §46, §47, §48)", () => {
  let tempDir: string;
  let workspaceDir: string;
  let userHomeDir: string;
  let mockRunner: MockSubprocessRunner;
  let originalHome: string | undefined;
  let originalEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "grok-build-test-"));
    workspaceDir = path.join(tempDir, "workspace");
    userHomeDir = path.join(tempDir, "home");
    await fsp.mkdir(workspaceDir, { recursive: true });
    await fsp.mkdir(userHomeDir, { recursive: true });

    mockRunner = createMockSubprocessRunner();
    mockRunner.installGlobalHook();

    originalHome = process.env.HOME;
    originalEnv = {
      GROK_BUILD: process.env.GROK_BUILD,
      GROK_HOME: process.env.GROK_HOME,
      GROK_SESSION: process.env.GROK_SESSION,
      GROK_SESSION_ID: process.env.GROK_SESSION_ID,
      GROK_PROJECT_DIR: process.env.GROK_PROJECT_DIR,
      GROK_CONFIG_DIR: process.env.GROK_CONFIG_DIR,
      GROK_VERSION: process.env.GROK_VERSION,
      GROK_POLICY_FILE: process.env.GROK_POLICY_FILE,
      GROK_MANAGED_CONFIG: process.env.GROK_MANAGED_CONFIG,
      GROK_SUBAGENTS: process.env.GROK_SUBAGENTS,
      GROK_MAX_CONCURRENCY: process.env.GROK_MAX_CONCURRENCY,
      GROK_PARALLELISM: process.env.GROK_PARALLELISM,
      GROK_WORKTREE_ISOLATION: process.env.GROK_WORKTREE_ISOLATION,
    };

    process.env.HOME = userHomeDir;
    delete process.env.GROK_BUILD;
    delete process.env.GROK_HOME;
    delete process.env.GROK_SESSION;
    delete process.env.GROK_SESSION_ID;
    delete process.env.GROK_PROJECT_DIR;
    delete process.env.GROK_CONFIG_DIR;
    delete process.env.GROK_VERSION;
    delete process.env.GROK_POLICY_FILE;
    delete process.env.GROK_MANAGED_CONFIG;
    delete process.env.GROK_SUBAGENTS;
    delete process.env.GROK_MAX_CONCURRENCY;
    delete process.env.GROK_PARALLELISM;
    delete process.env.GROK_WORKTREE_ISOLATION;
  });

  afterEach(async () => {
    mockRunner.uninstallGlobalHook();
    mockRunner.reset();

    process.env.HOME = originalHome;
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }

    if (fs.existsSync(tempDir)) {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  describe("Host Identification & Runtime Context (§44)", () => {
    it("identifies Grok Build from environment variables", async () => {
      const adapter = new GrokBuildAdapter();
      expect(adapter.hasActiveRuntimeContext(workspaceDir)).toBe(false);

      process.env.GROK_BUILD = "1";
      expect(adapter.hasActiveRuntimeContext(workspaceDir)).toBe(true);
      expect(await adapter.identifyHost(workspaceDir)).toBe(true);

      delete process.env.GROK_BUILD;
      process.env.GROK_SESSION = "sess-123";
      expect(adapter.hasActiveRuntimeContext(workspaceDir)).toBe(true);
      expect(await adapter.identifyHost(workspaceDir)).toBe(true);

      delete process.env.GROK_SESSION;
      process.env.GROK_PROJECT_DIR = workspaceDir;
      expect(adapter.hasActiveRuntimeContext(workspaceDir)).toBe(true);
      expect(await adapter.identifyHost(workspaceDir)).toBe(true);
    });

    it("identifies Grok Build from workspace .grok directory or config.toml", async () => {
      const adapter = new GrokBuildAdapter();
      expect(await adapter.identifyHost(workspaceDir)).toBe(false);

      await fsp.mkdir(path.join(workspaceDir, ".grok"), { recursive: true });
      expect(await adapter.identifyHost(workspaceDir)).toBe(true);
    });

    it("identifies Grok Build from workspace grok.toml file", async () => {
      const adapter = new GrokBuildAdapter();
      await fsp.writeFile(path.join(workspaceDir, "grok.toml"), 'model = "grok-2"\n', "utf-8");
      expect(await adapter.identifyHost(workspaceDir)).toBe(true);
    });

    it("identifies Grok Build from user home ~/.grok when no workspace supplied", async () => {
      const adapter = new GrokBuildAdapter();
      await fsp.mkdir(path.join(userHomeDir, ".grok"), { recursive: true });
      expect(await adapter.identifyHost()).toBe(true);
    });

    it("returns false cleanly for empty workspace without grok markers", async () => {
      const adapter = new GrokBuildAdapter();
      expect(await adapter.identifyHost(workspaceDir)).toBe(false);
      expect(await adapter.identifyHost()).toBe(false);
    });
  });

  describe("Version Inspection & Compatibility (§21, §22, §44)", () => {
    it("reports unknown-version and fails closed when unevidenced", async () => {
      const adapter = new GrokBuildAdapter();
      const version = await adapter.inspectVersion(workspaceDir);
      expect(version.compatibility).toBe("unknown-version");
      expect(version.fail_closed_for_mutation).toBe(true);
    });

    it("detects supported version from GROK_VERSION env (0.x, 1.x)", async () => {
      process.env.GROK_VERSION = "1.2.0";
      const adapter = new GrokBuildAdapter();
      const version = await adapter.inspectVersion(workspaceDir);
      expect(version.compatibility).toBe("supported");
      expect(version.fail_closed_for_mutation).toBe(false);
      expect(version.version).toBe("1.2.0");
    });

    it("detects partially-supported version for 2.x", async () => {
      process.env.GROK_VERSION = "2.0.1";
      const adapter = new GrokBuildAdapter();
      const version = await adapter.inspectVersion(workspaceDir);
      expect(version.compatibility).toBe("partially-supported");
      expect(version.fail_closed_for_mutation).toBe(false);
      expect(version.version).toBe("2.0.1");
    });

    it("detects incompatible version", async () => {
      process.env.GROK_VERSION = "incompatible";
      const adapter = new GrokBuildAdapter();
      const version = await adapter.inspectVersion(workspaceDir);
      expect(version.compatibility).toBe("incompatible");
      expect(version.fail_closed_for_mutation).toBe(true);
    });

    it("detects version from workspace .grok/version file", async () => {
      const grokDir = path.join(workspaceDir, ".grok");
      await fsp.mkdir(grokDir, { recursive: true });
      await fsp.writeFile(path.join(grokDir, "version"), "1.0.5\n", "utf-8");

      const adapter = new GrokBuildAdapter();
      const version = await adapter.inspectVersion(workspaceDir);
      expect(version.compatibility).toBe("supported");
      expect(version.version).toBe("1.0.5");
    });

    it("detects version from CLI grok --version", async () => {
      mockRunner.register("grok", {
        exitCode: 0,
        stdout: "grok-build 1.4.2 (rev 829fa)",
      }, [/--version/]);

      const adapter = new GrokBuildAdapter();
      const version = await adapter.inspectVersion(workspaceDir);
      expect(version.compatibility).toBe("supported");
      expect(version.version).toBe("1.4.2");
    });
  });

  describe("Runtime Inspection Priority (`grok inspect --json`) (§45)", () => {
    it("prioritizes machine-readable runtime inspection over manual TOML parsing", async () => {
      // 1. Put different models in TOML vs runtime inspect
      const grokDir = path.join(workspaceDir, ".grok");
      await fsp.mkdir(grokDir, { recursive: true });
      await fsp.writeFile(
        path.join(grokDir, "config.toml"),
        'model = "grok-toml-model"\nsupported_effort_values = ["low"]\n',
        "utf-8"
      );

      // 2. Mock `grok inspect --json`
      mockRunner.mockInspect("grok", {
        version: "1.3.0",
        model: "grok-2",
        worker_model: "grok-2-mini",
        supported_models: ["grok-2", "grok-2-mini", "grok-code"],
        reasoning_effort: "high",
        supported_effort_values: ["low", "medium", "high", "xhigh"],
        subagents: {
          enabled: true,
          parallel: true,
          worktrees: true,
          agent_specific_model: true,
        },
        parallelism: {
          enabled: true,
          max_concurrency: 4,
        },
      });

      const adapter = new GrokBuildAdapter();
      const models = await adapter.inspectModels(workspaceDir);

      // Models must come from runtime inspection with kind "host-runtime"
      expect(models.length).toBeGreaterThanOrEqual(3);
      expect(models.map((m) => m.id)).toContain("grok-2");
      expect(models.map((m) => m.id)).toContain("grok-2-mini");
      expect(models.map((m) => m.id)).toContain("grok-code");
      expect(models.every((m) => m.evidence?.kind === "host-runtime")).toBe(true);
      expect(models.every((m) => m.evidence?.locator === "grok inspect --json")).toBe(true);

      // Capabilities must be populated from runtime inspection
      const caps = await adapter.inspectCapabilities(workspaceDir);
      expect(caps.capabilities.subagents.state).toBe("available");
      expect(caps.capabilities.subagents.evidence?.locator).toBe("grok inspect --json");
      expect(caps.capabilities.parallelism.state).toBe("available");
      expect(caps.capabilities.concurrency?.max_concurrency).toBe(4);
      expect(caps.supported_effort_values).toEqual(["low", "medium", "high", "xhigh"]);

      const topology = await adapter.inspectExecutionTopologyCapabilities(workspaceDir);
      expect(topology.supports_subagents).toBe(true);
      expect(topology.supports_parallel_execution).toBe(true);
      expect(topology.max_concurrency).toBe(4);
    });

    it("falls back to TOML file parsing when `grok inspect --json` fails or is absent", async () => {
      mockRunner.mockFailure("grok", 1, "Command not found", [/inspect/]);

      const grokDir = path.join(workspaceDir, ".grok");
      await fsp.mkdir(grokDir, { recursive: true });
      await fsp.writeFile(
        path.join(grokDir, "config.toml"),
        'model = "grok-2"\nworker_model = "grok-2-mini"\nmodels = ["grok-2", "grok-2-mini"]\n',
        "utf-8"
      );

      const adapter = new GrokBuildAdapter();
      const models = await adapter.inspectModels(workspaceDir);
      expect(models.map((m) => m.id)).toEqual(["grok-2", "grok-2-mini"]);
      expect(models[0].evidence?.kind).toBe("host-config");
    });
  });

  describe("Config Layering & Managed/Policy Protection (§46)", () => {
    it("respects hierarchy precedence: Policy > Managed > Project > User", async () => {
      // 1. User config
      const userGrokDir = path.join(userHomeDir, ".grok");
      await fsp.mkdir(userGrokDir, { recursive: true });
      await fsp.writeFile(
        path.join(userGrokDir, "config.toml"),
        'model = "grok-user"\nreasoning_effort = "low"\n',
        "utf-8"
      );

      // 2. Project config
      const projGrokDir = path.join(workspaceDir, ".grok");
      await fsp.mkdir(projGrokDir, { recursive: true });
      await fsp.writeFile(
        path.join(projGrokDir, "config.toml"),
        'model = "grok-project"\nreasoning_effort = "medium"\n',
        "utf-8"
      );

      const adapter = new GrokBuildAdapter();
      let layered = adapter.readLayeredConfig(workspaceDir);
      expect(layered.effectiveConfig.model).toBe("grok-project");
      expect(layered.effectiveConfig.reasoning_effort).toBe("medium");

      // 3. Managed config overrides Project
      const managedFile = path.join(workspaceDir, ".grok", "managed.toml");
      await fsp.writeFile(
        managedFile,
        'model = "grok-managed"\n',
        "utf-8"
      );
      layered = adapter.readLayeredConfig(workspaceDir);
      expect(layered.effectiveConfig.model).toBe("grok-managed");
      expect(layered.effectiveConfig.reasoning_effort).toBe("medium"); // from project

      // 4. Policy config overrides Managed
      const policyFile = path.join(workspaceDir, ".grok", "policy.toml");
      await fsp.writeFile(
        policyFile,
        'model = "grok-enterprise-policy"\nreasoning_effort = "high"\n',
        "utf-8"
      );
      layered = adapter.readLayeredConfig(workspaceDir);
      expect(layered.effectiveConfig.model).toBe("grok-enterprise-policy");
      expect(layered.effectiveConfig.reasoning_effort).toBe("high");
    });

    it("NEVER flattens effective config into ~/.grok/config.toml (§46)", async () => {
      const projGrokDir = path.join(workspaceDir, ".grok");
      await fsp.mkdir(projGrokDir, { recursive: true });
      await fsp.writeFile(
        path.join(projGrokDir, "config.toml"),
        'model = "grok-project"\n',
        "utf-8"
      );

      const userConfigFile = path.join(userHomeDir, ".grok", "config.toml");

      const adapter = new GrokBuildAdapter();
      const plan: ExecutionConfig = {
        execution_id: "plan-no-flatten",
        controller: { model: "grok-project" },
        execution: { model: "grok-project" },
      };

      const preview = await adapter.previewConfiguration(plan, undefined, workspaceDir);

      // Target must be strictly inside workspace, NOT user config!
      expect(preview.mutation_targets).toContain(path.join(projGrokDir, "config.toml"));
      expect(preview.mutation_targets.some((t) => t.startsWith(userHomeDir))).toBe(false);

      // User config must NOT exist or have been modified
      expect(fs.existsSync(userConfigFile)).toBe(false);
    });

    it("fails closed with policy violation error when attempting to override locked policy model", async () => {
      const policyFile = path.join(workspaceDir, ".grok", "policy.toml");
      await fsp.mkdir(path.join(workspaceDir, ".grok"), { recursive: true });
      await fsp.writeFile(
        policyFile,
        'model = "grok-locked-policy"\n',
        "utf-8"
      );

      const adapter = new GrokBuildAdapter();
      const plan: ExecutionConfig = {
        execution_id: "plan-policy-violation",
        controller: { model: "grok-different-model" },
        execution: { model: "grok-different-model" },
      };

      await expect(
        adapter.previewConfiguration(plan, undefined, workspaceDir)
      ).rejects.toThrow(/Policy violation/);
    });

    it("fails closed with policy violation error when attempting to override locked managed model", async () => {
      const managedFile = path.join(workspaceDir, ".grok", "managed.toml");
      await fsp.mkdir(path.join(workspaceDir, ".grok"), { recursive: true });
      await fsp.writeFile(
        managedFile,
        'model = "grok-locked-managed"\n',
        "utf-8"
      );

      const adapter = new GrokBuildAdapter();
      const plan: ExecutionConfig = {
        execution_id: "plan-managed-violation",
        controller: { model: "grok-different-model" },
        execution: { model: "grok-different-model" },
      };

      await expect(
        adapter.previewConfiguration(plan, undefined, workspaceDir)
      ).rejects.toThrow(/Policy violation/);
    });

    it("fails closed when policy specifies deny_mutation = true", async () => {
      const policyFile = path.join(workspaceDir, ".grok", "policy.toml");
      await fsp.mkdir(path.join(workspaceDir, ".grok"), { recursive: true });
      await fsp.writeFile(
        policyFile,
        "deny_mutation = true\n",
        "utf-8"
      );

      const adapter = new GrokBuildAdapter();
      const plan: ExecutionConfig = {
        execution_id: "plan-denied",
        controller: { model: "grok-2" },
        execution: { model: "grok-2" },
      };

      await expect(
        adapter.previewConfiguration(plan, undefined, workspaceDir)
      ).rejects.toThrow(/Policy violation/);
    });
  });

  describe("Subagents, Parallelism & Worktrees Authentic Inspection (§48)", () => {
    it("reports unknown in clean unconfigured workspace (no blanket assumption)", async () => {
      const adapter = new GrokBuildAdapter();
      const caps = await adapter.inspectCapabilities(workspaceDir);

      expect(caps.capabilities.subagents.state).toBe("unknown");
      expect(caps.capabilities.threads.state).toBe("unknown");
      expect(caps.capabilities.parallelism.state).toBe("unknown");
      expect(caps.capabilities.concurrency?.state).toBe("unknown");
      expect(caps.capabilities.model_selection.state).toBe("unknown");
      expect(caps.capabilities.per_agent_model_selection?.state).toBe("unknown");
      expect(caps.capabilities.reasoning?.state).toBe("unknown");

      const topology = await adapter.inspectExecutionTopologyCapabilities(workspaceDir);
      expect(topology.supports_subagents).toBe(false);
      expect(topology.supports_parallel_execution).toBe(false);
    });

    it("reports subagents available when .grok/agents exists", async () => {
      await fsp.mkdir(path.join(workspaceDir, ".grok", "agents"), { recursive: true });

      const adapter = new GrokBuildAdapter();
      const caps = await adapter.inspectCapabilities(workspaceDir);

      expect(caps.capabilities.subagents.state).toBe("available");
      expect(caps.capabilities.subagents.evidence?.locator).toBe(
        path.join(workspaceDir, ".grok", "agents")
      );
      expect(caps.capabilities.threads.state).toBe("available");

      const topology = await adapter.inspectExecutionTopologyCapabilities(workspaceDir);
      expect(topology.supports_subagents).toBe(true);
      expect(topology.supports_multi_agent).toBe(true);
    });

    it("reports parallelism available ONLY when max_concurrency > 1 is confirmed", async () => {
      const grokDir = path.join(workspaceDir, ".grok");
      await fsp.mkdir(grokDir, { recursive: true });
      await fsp.writeFile(
        path.join(grokDir, "config.toml"),
        "max_concurrency = 4\n",
        "utf-8"
      );

      const adapter = new GrokBuildAdapter();
      const caps = await adapter.inspectCapabilities(workspaceDir);

      expect(caps.capabilities.parallelism.state).toBe("available");
      expect(caps.capabilities.concurrency?.state).toBe("available");
      expect(caps.capabilities.concurrency?.max_concurrency).toBe(4);

      const topology = await adapter.inspectExecutionTopologyCapabilities(workspaceDir);
      expect(topology.supports_parallel_execution).toBe(true);
      expect(topology.max_concurrency).toBe(4);
    });

    it("reports per-agent model selection when worker_model is defined", async () => {
      const grokDir = path.join(workspaceDir, ".grok");
      await fsp.mkdir(grokDir, { recursive: true });
      await fsp.writeFile(
        path.join(grokDir, "config.toml"),
        'model = "grok-2"\nworker_model = "grok-2-mini"\n',
        "utf-8"
      );

      const adapter = new GrokBuildAdapter();
      const caps = await adapter.inspectCapabilities(workspaceDir);
      expect(caps.capabilities.per_agent_model_selection?.state).toBe("available");
    });
  });

  describe("Companion MCP Registration Lifecycle (§47)", () => {
    it("detects existing companion registration in .grok/config.toml", async () => {
      const grokDir = path.join(workspaceDir, ".grok");
      await fsp.mkdir(grokDir, { recursive: true });
      await fsp.writeFile(
        path.join(grokDir, "config.toml"),
        'model = "grok-2"\n\n[mcp.servers.agent-config]\ncommand = "agent-config"\nargs = ["serve"]\n',
        "utf-8"
      );

      const adapter = new GrokBuildAdapter();
      const status = await adapter.inspectCompanionRegistration(workspaceDir);
      expect(status.registered).toBe(true);
      expect(status.command).toBe("agent-config");
      expect(status.args).toEqual(["serve"]);

      const validation = await adapter.validateCompanionRegistration(workspaceDir);
      expect(validation.valid).toBe(true);
    });

    it("detects companion registration in runtime inspection output", async () => {
      mockRunner.mockInspect("grok", {
        version: "1.2.0",
        mcp: {
          servers: {
            "agent-config": { command: "agent-config", args: ["serve"] },
          },
        },
      });

      const adapter = new GrokBuildAdapter();
      const status = await adapter.inspectCompanionRegistration(workspaceDir);
      expect(status.registered).toBe(true);
      expect(status.command).toBe("agent-config");
    });

    it("previews companion registration generating diff and hash", async () => {
      const grokDir = path.join(workspaceDir, ".grok");
      await fsp.mkdir(grokDir, { recursive: true });
      await fsp.writeFile(
        path.join(grokDir, "config.toml"),
        'model = "grok-2"\n',
        "utf-8"
      );

      const adapter = new GrokBuildAdapter();
      const preview = await adapter.previewCompanionRegistration(workspaceDir);

      expect(preview.supported).toBe(true);
      expect(preview.preview_id).toBeDefined();
      expect(preview.preview_hash).toBeDefined();
      expect(preview.diff).toContain("[mcp.servers.agent-config]");
      expect(preview.mutation_targets).toEqual([path.join(grokDir, "config.toml")]);
    });

    it("evaluates native grok mcp add command priority on apply (§47)", async () => {
      const grokDir = path.join(workspaceDir, ".grok");
      await fsp.mkdir(grokDir, { recursive: true });
      await fsp.writeFile(path.join(grokDir, "config.toml"), 'model = "grok-2"\n', "utf-8");

      mockRunner.register("grok", {
        exitCode: 0,
        stdout: "MCP server agent-config added successfully",
      }, [/mcp/, /add/]);

      const adapter = new GrokBuildAdapter();
      const preview = await adapter.previewCompanionRegistration(workspaceDir);
      const applyResult = await adapter.applyCompanionRegistration(preview.preview_hash!, workspaceDir);

      expect(applyResult.success).toBe(true);
      expect(applyResult.message).toContain("grok mcp add");
    });

    it("falls back to applying TOML patch when grok mcp add is not available", async () => {
      const grokDir = path.join(workspaceDir, ".grok");
      await fsp.mkdir(grokDir, { recursive: true });
      await fsp.writeFile(path.join(grokDir, "config.toml"), 'model = "grok-2"\n', "utf-8");

      // Mock CLI failure for grok mcp add
      mockRunner.mockFailure("grok", 1, "Command 'mcp add' not found", [/mcp/, /add/]);

      const adapter = new GrokBuildAdapter();
      const preview = await adapter.previewCompanionRegistration(workspaceDir);
      const applyResult = await adapter.applyCompanionRegistration(preview.preview_hash!, workspaceDir);

      expect(applyResult.success).toBe(true);
      const updated = await fsp.readFile(path.join(grokDir, "config.toml"), "utf-8");
      expect(updated).toContain("[mcp.servers.agent-config]");
      expect(updated).toContain('command = "agent-config"');
    });

    it("rejects companion apply with mismatched preview hash", async () => {
      const adapter = new GrokBuildAdapter();
      const applyResult = await adapter.applyCompanionRegistration("bogus-preview-hash-999", workspaceDir);
      expect(applyResult.success).toBe(false);
      expect(applyResult.error).toContain("mismatch");
    });
  });

  describe("Configuration Lifecycle & Validation (§48, §74)", () => {
    it("renders, applies, and validates single-model configuration", async () => {
      process.env.GROK_VERSION = "1.2.0"; // evidenced supported version
      const grokDir = path.join(workspaceDir, ".grok");
      await fsp.mkdir(grokDir, { recursive: true });
      await fsp.writeFile(path.join(grokDir, "config.toml"), 'model = "grok-1"\n', "utf-8");

      const adapter = new GrokBuildAdapter();
      const plan: ExecutionConfig = {
        execution_id: "plan-single",
        controller: { model: "grok-2", effort: "high" },
        execution: { model: "grok-2", effort: "high" },
      };

      const rendered = await adapter.renderConfiguration(plan, undefined, workspaceDir);
      expect(rendered.mutation_targets).toEqual([path.join(grokDir, "config.toml")]);
      expect(rendered.diff).toContain('model = "grok-2"');
      expect(rendered.diff).toContain('reasoning_effort = "high"');

      const apply = await adapter.applyConfiguration(rendered.preview_id, rendered, workspaceDir);
      expect(apply.success).toBe(true);

      const validation = await adapter.validateConfiguration(plan, workspaceDir);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toBeUndefined();
    });

    it("renders, applies, and validates decomposed worker agents under .grok/agents/ (§48)", async () => {
      process.env.GROK_VERSION = "1.2.0";
      const grokDir = path.join(workspaceDir, ".grok");
      await fsp.mkdir(grokDir, { recursive: true });
      await fsp.writeFile(path.join(grokDir, "config.toml"), 'model = "grok-2"\n', "utf-8");

      const decomposedPlan: ExecutionConfig = {
        task_shape: "decomposed",
        model_mode: "multi",
        readiness: "executable",
        controller: { model: "grok-2", effort: "high" },
        execution: { model: "grok-2" },
        work_items: [
          { ticket_id: "worker-01", model: "grok-2-mini", effort: "low" },
          { ticket_id: "worker-02", model: "grok-2-vision", effort: "high" },
        ],
      };

      const adapter = new GrokBuildAdapter();
      const rendered = await adapter.renderConfiguration(decomposedPlan, undefined, workspaceDir);

      expect(rendered.mutation_targets).toHaveLength(3);
      expect(rendered.mutation_targets).toContain(path.join(grokDir, "config.toml"));
      expect(rendered.mutation_targets).toContain(path.join(grokDir, "agents", "worker-01.toml"));
      expect(rendered.mutation_targets).toContain(path.join(grokDir, "agents", "worker-02.toml"));

      const apply = await adapter.applyConfiguration(rendered.preview_id, rendered, workspaceDir);
      expect(apply.success).toBe(true);

      // Verify agent files written
      const w1Content = await fsp.readFile(path.join(grokDir, "agents", "worker-01.toml"), "utf-8");
      expect(w1Content).toContain('model = "grok-2-mini"');
      expect(w1Content).toContain('reasoning_effort = "low"');

      const w2Content = await fsp.readFile(path.join(grokDir, "agents", "worker-02.toml"), "utf-8");
      expect(w2Content).toContain('model = "grok-2-vision"');
      expect(w2Content).toContain('reasoning_effort = "high"');

      // Validation succeeds
      const validation = await adapter.validateConfiguration(decomposedPlan, workspaceDir);
      expect(validation.valid).toBe(true);

      // Tampering detects drift
      await fsp.writeFile(
        path.join(grokDir, "agents", "worker-01.toml"),
        'name = "worker-01"\nmodel = "tampered-model"\n',
        "utf-8"
      );
      const tamperedValidation = await adapter.validateConfiguration(decomposedPlan, workspaceDir);
      expect(tamperedValidation.valid).toBe(false);
      expect(tamperedValidation.errors?.some((e) => e.includes("tampered-model") || e.includes("mismatch"))).toBe(true);
    });

    it("resolves abstract reasoning policies to native reasoning_effort field", async () => {
      const grokDir = path.join(workspaceDir, ".grok");
      await fsp.mkdir(grokDir, { recursive: true });
      await fsp.writeFile(
        path.join(grokDir, "config.toml"),
        'supported_effort_values = ["low", "medium", "high", "xhigh"]\n',
        "utf-8"
      );

      const adapter = new GrokBuildAdapter();
      const highest = await adapter.resolveReasoningPolicy("highest-supported", undefined, workspaceDir);
      expect(highest).toEqual({
        host_field: "reasoning_effort",
        host_value: "xhigh",
      });

      const lowest = await adapter.resolveReasoningPolicy("lowest-supported", undefined, workspaceDir);
      expect(lowest).toEqual({
        host_field: "reasoning_effort",
        host_value: "low",
      });

      const direct = await adapter.resolveReasoningPolicy("medium", undefined, workspaceDir);
      expect(direct).toEqual({
        host_field: "reasoning_effort",
        host_value: "medium",
      });
    });
  });
});
