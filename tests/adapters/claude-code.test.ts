import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ClaudeCodeAdapter } from "../../src/adapters/claude-code/index.js";
import { ExecutionConfig } from "../../src/profile/schema.js";

describe("Claude Code Native Adapter Tests (§27, §28)", () => {
  let tempDir: string;
  let workspaceDir: string;
  let userHomeDir: string;
  let originalHome: string | undefined;
  let originalEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "claude-code-test-"));
    workspaceDir = path.join(tempDir, "workspace");
    userHomeDir = path.join(tempDir, "home");
    await fsp.mkdir(workspaceDir, { recursive: true });
    await fsp.mkdir(userHomeDir, { recursive: true });

    originalHome = process.env.HOME;
    originalEnv = {
      CLAUDE_CODE: process.env.CLAUDE_CODE,
      CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR,
      CLAUDE_SESSION_ID: process.env.CLAUDE_SESSION_ID,
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
      CLAUDE_VERSION: process.env.CLAUDE_VERSION,
      CLAUDE_MODEL: process.env.CLAUDE_MODEL,
      CLAUDE_MAX_CONCURRENCY: process.env.CLAUDE_MAX_CONCURRENCY,
      CLAUDE_REASONING_EFFORT: process.env.CLAUDE_REASONING_EFFORT,
      CLAUDE_THINKING: process.env.CLAUDE_THINKING,
    };

    process.env.HOME = userHomeDir;
    delete process.env.CLAUDE_CODE;
    delete process.env.CLAUDE_PROJECT_DIR;
    delete process.env.CLAUDE_SESSION_ID;
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CLAUDE_VERSION;
    delete process.env.CLAUDE_MODEL;
    delete process.env.CLAUDE_MAX_CONCURRENCY;
    delete process.env.CLAUDE_REASONING_EFFORT;
    delete process.env.CLAUDE_THINKING;
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
    it("identifies Claude Code from environment variables", async () => {
      const adapter = new ClaudeCodeAdapter();
      expect(adapter.hasActiveRuntimeContext(workspaceDir)).toBe(false);

      process.env.CLAUDE_CODE = "1";
      expect(adapter.hasActiveRuntimeContext(workspaceDir)).toBe(true);
      expect(await adapter.identifyHost(workspaceDir)).toBe(true);

      delete process.env.CLAUDE_CODE;
      process.env.CLAUDE_PROJECT_DIR = workspaceDir;
      expect(adapter.hasActiveRuntimeContext(workspaceDir)).toBe(true);
      expect(await adapter.identifyHost(workspaceDir)).toBe(true);
    });

    it("identifies Claude Code from workspace .claude directory", async () => {
      const adapter = new ClaudeCodeAdapter();
      expect(await adapter.identifyHost(workspaceDir)).toBe(false);

      await fsp.mkdir(path.join(workspaceDir, ".claude"), { recursive: true });
      expect(await adapter.identifyHost(workspaceDir)).toBe(true);
    });

    it("identifies Claude Code from workspace .claude.json file", async () => {
      const adapter = new ClaudeCodeAdapter();
      await fsp.writeFile(path.join(workspaceDir, ".claude.json"), "{}", "utf-8");
      expect(await adapter.identifyHost(workspaceDir)).toBe(true);
    });

    it("identifies Claude Code from user ~/.claude directory when no workspace supplied", async () => {
      const adapter = new ClaudeCodeAdapter();
      await fsp.mkdir(path.join(userHomeDir, ".claude"), { recursive: true });
      expect(await adapter.identifyHost()).toBe(true);
    });
  });

  describe("Version Inspection & Compatibility", () => {
    it("reports unknown-version and fails closed when version is unevidenced", async () => {
      const adapter = new ClaudeCodeAdapter();
      const version = await adapter.inspectVersion(workspaceDir);
      expect(version.compatibility).toBe("unknown-version");
      expect(version.fail_closed_for_mutation).toBe(true);
    });

    it("detects supported version from CLAUDE_VERSION env", async () => {
      process.env.CLAUDE_VERSION = "1.0.5";
      const adapter = new ClaudeCodeAdapter();
      const version = await adapter.inspectVersion(workspaceDir);
      expect(version.compatibility).toBe("supported");
      expect(version.fail_closed_for_mutation).toBe(false);
      expect(version.version).toBe("1.0.5");
    });

    it("detects version from workspace .claude/version", async () => {
      await fsp.mkdir(path.join(workspaceDir, ".claude"), { recursive: true });
      await fsp.writeFile(path.join(workspaceDir, ".claude", "version"), "0.9.2\n", "utf-8");
      const adapter = new ClaudeCodeAdapter();
      const version = await adapter.inspectVersion(workspaceDir);
      expect(version.compatibility).toBe("supported");
      expect(version.version).toBe("0.9.2");
    });

    it("detects incompatible version and enforces fail-closed", async () => {
      process.env.CLAUDE_VERSION = "incompatible";
      const adapter = new ClaudeCodeAdapter();
      const version = await adapter.inspectVersion(workspaceDir);
      expect(version.compatibility).toBe("incompatible");
      expect(version.fail_closed_for_mutation).toBe(true);
    });
  });

  describe("Config Hierarchy & Precedence (User vs Project)", () => {
    it("project settings override user settings for model and configuration", async () => {
      // User settings
      await fsp.mkdir(path.join(userHomeDir, ".claude"), { recursive: true });
      await fsp.writeFile(
        path.join(userHomeDir, ".claude", "settings.json"),
        JSON.stringify({ model: "claude-3-5-haiku-20241022", theme: "dark" }),
        "utf-8"
      );

      // Workspace settings
      await fsp.mkdir(path.join(workspaceDir, ".claude"), { recursive: true });
      await fsp.writeFile(
        path.join(workspaceDir, ".claude", "settings.json"),
        JSON.stringify({ model: "claude-3-7-sonnet-20250219" }),
        "utf-8"
      );

      const adapter = new ClaudeCodeAdapter();
      const effective = adapter.readEffectiveConfig(workspaceDir);
      expect(effective?.model).toBe("claude-3-7-sonnet-20250219");
      expect(effective?.theme).toBe("dark"); // inherited from user
    });
  });

  describe("Subagents & Custom Agents (.claude/agents/*.md)", () => {
    it("discovers custom agents with frontmatter and per-agent models", async () => {
      const agentsDir = path.join(workspaceDir, ".claude", "agents");
      await fsp.mkdir(agentsDir, { recursive: true });

      await fsp.writeFile(
        path.join(agentsDir, "researcher.md"),
        [
          "---",
          'name: "researcher"',
          'model: "claude-3-5-haiku-20241022"',
          'description: "Fast exploration agent"',
          "---",
          "Instructions for researcher...",
        ].join("\n"),
        "utf-8"
      );

      await fsp.writeFile(
        path.join(agentsDir, "coder.md"),
        [
          "---",
          'name: "coder"',
          'model: "claude-3-7-sonnet-20250219"',
          'description: "Implementation worker"',
          "---",
          "Instructions for coder...",
        ].join("\n"),
        "utf-8"
      );

      const adapter = new ClaudeCodeAdapter();
      const agents = await adapter.inspectCustomAgents(workspaceDir);
      expect(agents).toHaveLength(2);
      expect(agents.find((a) => a.name === "researcher")?.model).toBe(
        "claude-3-5-haiku-20241022"
      );
      expect(agents.find((a) => a.name === "coder")?.model).toBe(
        "claude-3-7-sonnet-20250219"
      );

      // Capabilities reflect subagent availability
      const caps = await adapter.inspectCapabilities(workspaceDir);
      expect(caps.capabilities.subagents.state).toBe("available");
      expect(caps.capabilities.per_agent_model_selection?.state).toBe("available");

      // Models list includes models evidenced from custom agents
      const models = await adapter.inspectModels(workspaceDir);
      expect(models.some((m) => m.id === "claude-3-5-haiku-20241022")).toBe(true);
      expect(models.some((m) => m.id === "claude-3-7-sonnet-20250219")).toBe(true);
    });

    it("reports subagents as unknown when no agents and no directory exist", async () => {
      const adapter = new ClaudeCodeAdapter();
      const caps = await adapter.inspectCapabilities(workspaceDir);
      expect(caps.capabilities.subagents.state).toBe("unknown");
      expect(caps.capabilities.per_agent_model_selection?.state).toBe("unknown");
    });
  });

  describe("Reasoning Controls & Honest Reporting", () => {
    it("reports unknown reasoning and empty supported values when unconfigured", async () => {
      const adapter = new ClaudeCodeAdapter();
      const caps = await adapter.inspectCapabilities(workspaceDir);
      expect(caps.capabilities.reasoning?.state).toBe("unknown");
      expect(caps.supported_effort_values).toEqual([]);

      const options = await adapter.inspectReasoningOptions(workspaceDir);
      expect(options.native_field).toBe("thinking");
      expect(options.supported_values).toEqual([]);

      const resolved = await adapter.resolveReasoningPolicy("highest-supported", undefined, workspaceDir);
      expect(resolved).toBeUndefined();
    });

    it("reports evidenced thinking capability when configured in settings.json", async () => {
      await fsp.mkdir(path.join(workspaceDir, ".claude"), { recursive: true });
      await fsp.writeFile(
        path.join(workspaceDir, ".claude", "settings.json"),
        JSON.stringify({
          model: "claude-3-7-sonnet-20250219",
          thinking: { type: "enabled", supported_values: ["low", "medium", "high"] },
        }),
        "utf-8"
      );

      const adapter = new ClaudeCodeAdapter();
      const caps = await adapter.inspectCapabilities(workspaceDir);
      expect(caps.capabilities.reasoning?.state).toBe("available");
      expect(caps.supported_effort_values).toEqual(["low", "medium", "high"]);

      const resolved = await adapter.resolveReasoningPolicy("highest-supported", undefined, workspaceDir);
      expect(resolved).toEqual({
        host_field: "thinking",
        host_value: "high",
      });
    });
  });

  describe("Companion MCP Registration Lifecycle", () => {
    it("manages Claude Code companion registration lifecycle", async () => {
      const adapter = new ClaudeCodeAdapter();

      // Initially unregistered
      const initialStatus = await adapter.inspectCompanionRegistration(workspaceDir);
      expect(initialStatus.registered).toBe(false);

      // Preview registration
      const preview = await adapter.previewCompanionRegistration(workspaceDir);
      expect(preview.supported).toBe(true);
      expect(preview.mutation_targets).toHaveLength(1);
      expect(preview.diff).toContain('"agent-config"');

      // Apply registration
      const applyResult = await adapter.applyCompanionRegistration(
        preview.preview_hash!,
        workspaceDir
      );
      expect(applyResult.success).toBe(true);

      // Validate registration
      const validation = await adapter.validateCompanionRegistration(workspaceDir);
      expect(validation.valid).toBe(true);
    });
  });

  describe("Configuration Preview, Apply, and Drift Validation", () => {
    const singlePlan: ExecutionConfig = {
      task_shape: "single-pass",
      model_mode: "single",
      readiness: "executable",
      topology: { type: "single-session", concurrency: 1 },
      execution: { model: "claude-3-7-sonnet-20250219", effort: "high" },
    };

    const decomposedPlan: ExecutionConfig = {
      task_shape: "decomposed",
      model_mode: "multi",
      readiness: "executable",
      topology: { type: "controller-workers", concurrency: 2 },
      controller: { model: "claude-3-7-sonnet-20250219" },
      work_items: [
        {
          ticket_id: "01-core",
          difficulty: "routine",
          model: "claude-3-5-haiku-20241022",
        },
        {
          ticket_id: "02-complex",
          difficulty: "demanding",
          model: "claude-3-7-sonnet-20250219",
        },
      ],
    };

    it("renders and applies single-pass configuration to .claude/settings.json", async () => {
      const adapter = new ClaudeCodeAdapter();
      const rendered = await adapter.renderConfiguration(singlePlan, undefined, workspaceDir);

      expect(rendered.mutation_targets[0]).toBe(
        path.join(workspaceDir, ".claude", "settings.json")
      );
      expect(rendered.diff).toContain('"model": "claude-3-7-sonnet-20250219"');

      const apply = await adapter.applyConfiguration(rendered.preview_id, rendered, workspaceDir);
      expect(apply.success).toBe(true);

      const validation = await adapter.validateConfiguration(singlePlan, workspaceDir);
      expect(validation.valid).toBe(true);
    });

    it("renders and applies decomposed plan generating custom agent markdown files", async () => {
      const adapter = new ClaudeCodeAdapter();
      const rendered = await adapter.renderConfiguration(decomposedPlan, undefined, workspaceDir);

      // Expect settings.json + 2 agent markdown files
      expect(rendered.mutation_targets).toHaveLength(3);
      expect(rendered.mutation_targets).toContain(
        path.join(workspaceDir, ".claude", "agents", "01-core.md")
      );
      expect(rendered.mutation_targets).toContain(
        path.join(workspaceDir, ".claude", "agents", "02-complex.md")
      );

      const apply = await adapter.applyConfiguration(rendered.preview_id, rendered, workspaceDir);
      expect(apply.success).toBe(true);

      // Check agent markdown contents
      const agent1Content = await fsp.readFile(
        path.join(workspaceDir, ".claude", "agents", "01-core.md"),
        "utf-8"
      );
      expect(agent1Content).toContain('model: "claude-3-5-haiku-20241022"');

      const validation = await adapter.validateConfiguration(decomposedPlan, workspaceDir);
      expect(validation.valid).toBe(true);

      // Tamper to check drift detection
      await fsp.writeFile(
        path.join(workspaceDir, ".claude", "agents", "01-core.md"),
        '---\nname: "01-core"\nmodel: "tampered-model"\n---\n',
        "utf-8"
      );
      const driftValidation = await adapter.validateConfiguration(decomposedPlan, workspaceDir);
      expect(driftValidation.valid).toBe(false);
      expect(driftValidation.errors?.some((e) => e.includes("model mismatch"))).toBe(true);
    });
  });
});
