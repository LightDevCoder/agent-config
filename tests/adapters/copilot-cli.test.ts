import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { CopilotCliAdapter } from "../../src/adapters/copilot-cli/index.js";
import { ExecutionConfig } from "../../src/profile/schema.js";

describe("GitHub Copilot CLI Native Adapter Tests (§34, §35)", () => {
  let tempDir: string;
  let workspaceDir: string;
  let userHomeDir: string;
  let originalHome: string | undefined;
  let originalEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "copilot-cli-test-"));
    workspaceDir = path.join(tempDir, "workspace");
    userHomeDir = path.join(tempDir, "home");
    await fsp.mkdir(workspaceDir, { recursive: true });
    await fsp.mkdir(userHomeDir, { recursive: true });

    originalHome = process.env.HOME;
    originalEnv = {
      GITHUB_COPILOT_CLI: process.env.GITHUB_COPILOT_CLI,
      COPILOT_CLI: process.env.COPILOT_CLI,
      GITHUB_COPILOT: process.env.GITHUB_COPILOT,
      COPILOT_SESSION_ID: process.env.COPILOT_SESSION_ID,
      COPILOT_AGENT: process.env.COPILOT_AGENT,
      GH_COPILOT: process.env.GH_COPILOT,
      COPILOT_CONFIG_DIR: process.env.COPILOT_CONFIG_DIR,
      COPILOT_HOME: process.env.COPILOT_HOME,
      COPILOT_VERSION: process.env.COPILOT_VERSION,
      GITHUB_COPILOT_VERSION: process.env.GITHUB_COPILOT_VERSION,
      COPILOT_MODEL: process.env.COPILOT_MODEL,
      COPILOT_MAX_CONCURRENCY: process.env.COPILOT_MAX_CONCURRENCY,
      COPILOT_REASONING_EFFORT: process.env.COPILOT_REASONING_EFFORT,
    };

    process.env.HOME = userHomeDir;
    delete process.env.GITHUB_COPILOT_CLI;
    delete process.env.COPILOT_CLI;
    delete process.env.GITHUB_COPILOT;
    delete process.env.COPILOT_SESSION_ID;
    delete process.env.COPILOT_AGENT;
    delete process.env.GH_COPILOT;
    delete process.env.COPILOT_CONFIG_DIR;
    delete process.env.COPILOT_HOME;
    delete process.env.COPILOT_VERSION;
    delete process.env.GITHUB_COPILOT_VERSION;
    delete process.env.COPILOT_MODEL;
    delete process.env.COPILOT_MAX_CONCURRENCY;
    delete process.env.COPILOT_REASONING_EFFORT;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }

    if (fs.existsSync(tempDir)) {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  describe("Host Identification & Runtime Context", () => {
    it("identifies Copilot CLI from environment variables", async () => {
      const adapter = new CopilotCliAdapter();
      expect(adapter.hasActiveRuntimeContext(workspaceDir)).toBe(false);

      process.env.GITHUB_COPILOT_CLI = "1";
      expect(adapter.hasActiveRuntimeContext(workspaceDir)).toBe(true);
      expect(await adapter.identifyHost(workspaceDir)).toBe(true);

      delete process.env.GITHUB_COPILOT_CLI;
      process.env.COPILOT_AGENT = "worker";
      expect(adapter.hasActiveRuntimeContext(workspaceDir)).toBe(true);
      expect(await adapter.identifyHost(workspaceDir)).toBe(true);
    });

    it("identifies Copilot CLI from workspace .github/copilot directory", async () => {
      const adapter = new CopilotCliAdapter();
      expect(await adapter.identifyHost(workspaceDir)).toBe(false);

      await fsp.mkdir(path.join(workspaceDir, ".github", "copilot"), { recursive: true });
      expect(await adapter.identifyHost(workspaceDir)).toBe(true);
    });

    it("identifies Copilot CLI from workspace copilot.json", async () => {
      const adapter = new CopilotCliAdapter();
      await fsp.writeFile(path.join(workspaceDir, "copilot.json"), "{}", "utf-8");
      expect(await adapter.identifyHost(workspaceDir)).toBe(true);
    });

    it("identifies Copilot CLI from user directory when no workspace supplied", async () => {
      const adapter = new CopilotCliAdapter();
      await fsp.mkdir(path.join(userHomeDir, ".config", "github-copilot"), { recursive: true });
      expect(await adapter.identifyHost()).toBe(true);
    });
  });

  describe("Version Inspection & Compatibility", () => {
    it("reports unknown-version and fails closed when unevidenced", async () => {
      const adapter = new CopilotCliAdapter();
      const version = await adapter.inspectVersion(workspaceDir);
      expect(version.compatibility).toBe("unknown-version");
      expect(version.fail_closed_for_mutation).toBe(true);
    });

    it("detects supported version from COPILOT_VERSION env", async () => {
      process.env.COPILOT_VERSION = "1.2.0";
      const adapter = new CopilotCliAdapter();
      const version = await adapter.inspectVersion(workspaceDir);
      expect(version.compatibility).toBe("supported");
      expect(version.fail_closed_for_mutation).toBe(false);
      expect(version.version).toBe("1.2.0");
    });

    it("detects version from .github/copilot/version", async () => {
      const dir = path.join(workspaceDir, ".github", "copilot");
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(path.join(dir, "version"), "0.8.4\n", "utf-8");

      const adapter = new CopilotCliAdapter();
      const version = await adapter.inspectVersion(workspaceDir);
      expect(version.compatibility).toBe("supported");
      expect(version.version).toBe("0.8.4");
    });

    it("detects incompatible version", async () => {
      process.env.COPILOT_VERSION = "incompatible";
      const adapter = new CopilotCliAdapter();
      const version = await adapter.inspectVersion(workspaceDir);
      expect(version.compatibility).toBe("incompatible");
      expect(version.fail_closed_for_mutation).toBe(true);
    });
  });

  describe("Custom Agents vs Prompt Presets (§34)", () => {
    it("distinguishes custom agents with isolated worker contexts from simple prompt presets", async () => {
      const agentsDir = path.join(workspaceDir, ".github", "copilot", "agents");
      await fsp.mkdir(agentsDir, { recursive: true });

      // 1. Isolated custom worker agent
      await fsp.writeFile(
        path.join(agentsDir, "worker-agent.json"),
        JSON.stringify({
          name: "worker-agent",
          description: "Autonomous worker in isolated sandbox",
          model: "gpt-4o",
          context: "isolated-worker",
          isolated: true,
        }),
        "utf-8"
      );

      // 2. Simple prompt preset (template without isolation/agent capabilities)
      await fsp.writeFile(
        path.join(agentsDir, "pr-summary-preset.json"),
        JSON.stringify({
          name: "pr-summary-preset",
          prompt: "Summarize the PR changes concisely",
          description: "Simple prompt template",
        }),
        "utf-8"
      );

      // 3. Instructions file preset
      await fsp.writeFile(
        path.join(workspaceDir, ".github", "copilot-instructions.md"),
        "Follow repository coding conventions strictly.",
        "utf-8"
      );

      const adapter = new CopilotCliAdapter();
      const { agents, promptPresets } = await adapter.inspectCustomAgentsAndPresets(workspaceDir);

      expect(agents).toHaveLength(1);
      expect(agents[0].name).toBe("worker-agent");
      expect(agents[0].isolated).toBe(true);
      expect(agents[0].context).toBe("isolated-worker");
      expect(agents[0].model).toBe("gpt-4o");

      expect(promptPresets.some((p) => p.name === "pr-summary-preset")).toBe(true);
      expect(promptPresets.some((p) => p.name === "copilot-instructions.md")).toBe(true);

      // Capabilities reflect subagent availability due to real custom agent
      const caps = await adapter.inspectCapabilities(workspaceDir);
      expect(caps.capabilities.subagents.state).toBe("available");
      expect(caps.capabilities.per_agent_model_selection?.state).toBe("available");
    });

    it("reports subagents as unknown when only prompt presets are present", async () => {
      await fsp.mkdir(path.join(workspaceDir, ".github"), { recursive: true });
      await fsp.writeFile(
        path.join(workspaceDir, ".github", "copilot-instructions.md"),
        "Just a prompt preset.",
        "utf-8"
      );

      const adapter = new CopilotCliAdapter();
      const { agents, promptPresets } = await adapter.inspectCustomAgentsAndPresets(workspaceDir);
      expect(agents).toHaveLength(0);
      expect(promptPresets).toHaveLength(1);

      const caps = await adapter.inspectCapabilities(workspaceDir);
      expect(caps.capabilities.subagents.state).toBe("unknown");
      expect(caps.capabilities.per_agent_model_selection?.state).toBe("unknown");
    });
  });

  describe("Model Selection (Repo vs User Scope)", () => {
    it("repo-level model overrides user-level model", async () => {
      // User config
      const userConfigDir = path.join(userHomeDir, ".config", "github-copilot");
      await fsp.mkdir(userConfigDir, { recursive: true });
      await fsp.writeFile(
        path.join(userConfigDir, "config.json"),
        JSON.stringify({ model: "gpt-4o-mini" }),
        "utf-8"
      );

      // Repo config
      const repoDir = path.join(workspaceDir, ".github", "copilot");
      await fsp.mkdir(repoDir, { recursive: true });
      await fsp.writeFile(
        path.join(repoDir, "config.json"),
        JSON.stringify({ model: "claude-3.7-sonnet" }),
        "utf-8"
      );

      const adapter = new CopilotCliAdapter();
      const models = await adapter.inspectModels(workspaceDir);
      expect(models.some((m) => m.id === "claude-3.7-sonnet")).toBe(true);

      const effective = adapter.readEffectiveConfig(workspaceDir);
      expect(effective?.model).toBe("claude-3.7-sonnet");
    });
  });

  describe("Companion MCP Registration Lifecycle (§35)", () => {
    it("manages Copilot CLI companion registration lifecycle", async () => {
      const adapter = new CopilotCliAdapter();

      // Initially unregistered
      const initialStatus = await adapter.inspectCompanionRegistration(workspaceDir);
      expect(initialStatus.registered).toBe(false);

      // Preview
      const preview = await adapter.previewCompanionRegistration(workspaceDir);
      expect(preview.supported).toBe(true);
      expect(preview.mutation_targets).toHaveLength(1);
      expect(preview.diff).toContain('"agent-config"');

      // Apply
      const applyResult = await adapter.applyCompanionRegistration(
        preview.preview_hash!,
        workspaceDir
      );
      expect(applyResult.success).toBe(true);

      // Validate
      const validation = await adapter.validateCompanionRegistration(workspaceDir);
      expect(validation.valid).toBe(true);
    });
  });

  describe("Configuration Preview, Apply, and Validation Lifecycle", () => {
    const singlePlan: ExecutionConfig = {
      task_shape: "single-pass",
      model_mode: "single",
      readiness: "executable",
      topology: { type: "single-session", concurrency: 1 },
      execution: { model: "claude-3.7-sonnet", effort: "high" },
    };

    const decomposedPlan: ExecutionConfig = {
      task_shape: "decomposed",
      model_mode: "multi",
      readiness: "executable",
      topology: { type: "controller-workers", concurrency: 2 },
      controller: { model: "claude-3.7-sonnet" },
      work_items: [
        {
          ticket_id: "01-infra",
          difficulty: "routine",
          model: "gpt-4o-mini",
        },
        {
          ticket_id: "02-feature",
          difficulty: "demanding",
          model: "gpt-4o",
        },
      ],
    };

    it("renders and applies single-pass configuration to .github/copilot/config.json", async () => {
      const adapter = new CopilotCliAdapter();
      const rendered = await adapter.renderConfiguration(singlePlan, undefined, workspaceDir);

      expect(rendered.mutation_targets[0]).toBe(
        path.join(workspaceDir, ".github", "copilot", "config.json")
      );
      expect(rendered.diff).toContain('"model": "claude-3.7-sonnet"');

      const apply = await adapter.applyConfiguration(rendered.preview_id, rendered, workspaceDir);
      expect(apply.success).toBe(true);

      const validation = await adapter.validateConfiguration(singlePlan, workspaceDir);
      expect(validation.valid).toBe(true);
    });

    it("renders and applies decomposed plan generating isolated worker custom agent json files", async () => {
      const adapter = new CopilotCliAdapter();
      const rendered = await adapter.renderConfiguration(decomposedPlan, undefined, workspaceDir);

      expect(rendered.mutation_targets).toHaveLength(3);
      expect(rendered.mutation_targets).toContain(
        path.join(workspaceDir, ".github", "copilot", "agents", "01-infra.json")
      );
      expect(rendered.mutation_targets).toContain(
        path.join(workspaceDir, ".github", "copilot", "agents", "02-feature.json")
      );

      const apply = await adapter.applyConfiguration(rendered.preview_id, rendered, workspaceDir);
      expect(apply.success).toBe(true);

      // Verify agent files have isolated worker context
      const agent1Raw = await fsp.readFile(
        path.join(workspaceDir, ".github", "copilot", "agents", "01-infra.json"),
        "utf-8"
      );
      const agent1 = JSON.parse(agent1Raw);
      expect(agent1.model).toBe("gpt-4o-mini");
      expect(agent1.context).toBe("isolated-worker");
      expect(agent1.isolated).toBe(true);

      const validation = await adapter.validateConfiguration(decomposedPlan, workspaceDir);
      expect(validation.valid).toBe(true);

      // Tamper to check drift
      await fsp.writeFile(
        path.join(workspaceDir, ".github", "copilot", "agents", "01-infra.json"),
        JSON.stringify({ name: "01-infra", model: "drifted-model" }),
        "utf-8"
      );
      const driftValidation = await adapter.validateConfiguration(decomposedPlan, workspaceDir);
      expect(driftValidation.valid).toBe(false);
      expect(driftValidation.errors?.some((e) => e.includes("model mismatch"))).toBe(true);
    });
  });
});
