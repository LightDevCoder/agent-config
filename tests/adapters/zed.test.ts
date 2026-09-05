import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ZedAdapter } from "../../src/adapters/zed/index.js";
import { ExecutionConfig } from "../../src/profile/schema.js";

describe("Zed Native Adapter Tests (§38)", () => {
  let tempDir: string;
  let workspaceDir: string;
  let userHomeDir: string;
  let originalHome: string | undefined;
  let originalEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "zed-adapter-test-"));
    workspaceDir = path.join(tempDir, "workspace");
    userHomeDir = path.join(tempDir, "home");
    await fsp.mkdir(workspaceDir, { recursive: true });
    await fsp.mkdir(userHomeDir, { recursive: true });

    originalHome = process.env.HOME;
    originalEnv = {
      ZED_AGENT: process.env.ZED_AGENT,
      ZED_APP: process.env.ZED_APP,
      ZED_WINDOW_ID: process.env.ZED_WINDOW_ID,
      ZED_PID: process.env.ZED_PID,
      ZED_TERM: process.env.ZED_TERM,
      ZED_PATH: process.env.ZED_PATH,
      ZED_SESSION_ID: process.env.ZED_SESSION_ID,
      ZED_HOME: process.env.ZED_HOME,
      ZED_VERSION: process.env.ZED_VERSION,
      ZED_MODEL: process.env.ZED_MODEL,
      ZED_AGENT_PATH: process.env.ZED_AGENT_PATH,
      ZED_MAX_CONCURRENCY: process.env.ZED_MAX_CONCURRENCY,
      ZED_REASONING_EFFORT: process.env.ZED_REASONING_EFFORT,
    };

    process.env.HOME = userHomeDir;
    delete process.env.ZED_AGENT;
    delete process.env.ZED_APP;
    delete process.env.ZED_WINDOW_ID;
    delete process.env.ZED_PID;
    delete process.env.ZED_TERM;
    delete process.env.ZED_PATH;
    delete process.env.ZED_SESSION_ID;
    delete process.env.ZED_HOME;
    delete process.env.ZED_VERSION;
    delete process.env.ZED_MODEL;
    delete process.env.ZED_AGENT_PATH;
    delete process.env.ZED_MAX_CONCURRENCY;
    delete process.env.ZED_REASONING_EFFORT;
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
    it("identifies Zed from environment variables", async () => {
      const adapter = new ZedAdapter();
      expect(adapter.hasActiveRuntimeContext(workspaceDir)).toBe(false);

      process.env.ZED_AGENT = "1";
      expect(adapter.hasActiveRuntimeContext(workspaceDir)).toBe(true);
      expect(await adapter.identifyHost(workspaceDir)).toBe(true);

      delete process.env.ZED_AGENT;
      process.env.ZED_WINDOW_ID = "42";
      expect(adapter.hasActiveRuntimeContext(workspaceDir)).toBe(true);
      expect(await adapter.identifyHost(workspaceDir)).toBe(true);
    });

    it("identifies Zed from workspace .zed directory", async () => {
      const adapter = new ZedAdapter();
      expect(await adapter.identifyHost(workspaceDir)).toBe(false);

      await fsp.mkdir(path.join(workspaceDir, ".zed"), { recursive: true });
      expect(await adapter.identifyHost(workspaceDir)).toBe(true);
    });

    it("identifies Zed from user config directory when no workspace supplied", async () => {
      const adapter = new ZedAdapter();
      await fsp.mkdir(path.join(userHomeDir, ".config", "zed"), { recursive: true });
      expect(await adapter.identifyHost()).toBe(true);
    });
  });

  describe("Zed Agent Path Distinction (§38)", () => {
    it("defaults to zed-agent (native internal agent)", () => {
      const adapter = new ZedAdapter();
      expect(adapter.getAgentPath(workspaceDir)).toBe("zed-agent");
    });

    it("resolves external-acp from environment variable", () => {
      const adapter = new ZedAdapter();
      process.env.ZED_AGENT_PATH = "external-acp";
      expect(adapter.getAgentPath(workspaceDir)).toBe("external-acp");
    });

    it("resolves terminal-thread from environment variable", () => {
      const adapter = new ZedAdapter();
      process.env.ZED_AGENT_PATH = "terminal-thread";
      expect(adapter.getAgentPath(workspaceDir)).toBe("terminal-thread");
    });

    it("resolves agent path from .zed/settings.json", async () => {
      const zedDir = path.join(workspaceDir, ".zed");
      await fsp.mkdir(zedDir, { recursive: true });
      await fsp.writeFile(
        path.join(zedDir, "settings.json"),
        JSON.stringify({ agent_path: "external-acp" }),
        "utf-8"
      );

      const adapter = new ZedAdapter();
      expect(adapter.getAgentPath(workspaceDir)).toBe("external-acp");
    });
  });

  describe("Version Inspection & Compatibility", () => {
    it("reports unknown-version and fails closed when unevidenced", async () => {
      const adapter = new ZedAdapter();
      const version = await adapter.inspectVersion(workspaceDir);
      expect(version.compatibility).toBe("unknown-version");
      expect(version.fail_closed_for_mutation).toBe(true);
    });

    it("detects supported version from ZED_VERSION env", async () => {
      process.env.ZED_VERSION = "0.178.0";
      const adapter = new ZedAdapter();
      const version = await adapter.inspectVersion(workspaceDir);
      expect(version.compatibility).toBe("supported");
      expect(version.fail_closed_for_mutation).toBe(false);
      expect(version.version).toBe("0.178.0");
    });

    it("detects version from .zed/version file", async () => {
      const zedDir = path.join(workspaceDir, ".zed");
      await fsp.mkdir(zedDir, { recursive: true });
      await fsp.writeFile(path.join(zedDir, "version"), "0.175.2\n", "utf-8");

      const adapter = new ZedAdapter();
      const version = await adapter.inspectVersion(workspaceDir);
      expect(version.compatibility).toBe("supported");
      expect(version.version).toBe("0.175.2");
    });

    it("detects partially-supported version 2.x", async () => {
      process.env.ZED_VERSION = "2.0.0";
      const adapter = new ZedAdapter();
      const version = await adapter.inspectVersion(workspaceDir);
      expect(version.compatibility).toBe("partially-supported");
      expect(version.fail_closed_for_mutation).toBe(false);
    });

    it("detects incompatible version", async () => {
      process.env.ZED_VERSION = "incompatible";
      const adapter = new ZedAdapter();
      const version = await adapter.inspectVersion(workspaceDir);
      expect(version.compatibility).toBe("incompatible");
      expect(version.fail_closed_for_mutation).toBe(true);
    });
  });

  describe("Agent Profiles, LLM Providers, and Default Model (§38)", () => {
    it("inspects default model and agent profiles from .zed/settings.json", async () => {
      const zedDir = path.join(workspaceDir, ".zed");
      await fsp.mkdir(zedDir, { recursive: true });
      await fsp.writeFile(
        path.join(zedDir, "settings.json"),
        JSON.stringify({
          assistant: {
            default_model: {
              provider: "zed.dev",
              model: "claude-3-7-sonnet",
            },
            profiles: {
              worker: { model: "claude-3-5-haiku" },
            },
          },
        }),
        "utf-8"
      );

      const adapter = new ZedAdapter();
      const models = await adapter.inspectModels(workspaceDir);
      expect(models.map((m) => m.id)).toContain("claude-3-7-sonnet");
      expect(models.map((m) => m.id)).toContain("claude-3-5-haiku");

      const caps = await adapter.inspectCapabilities(workspaceDir);
      expect(caps.capabilities.subagents.state).toBe("available");
      expect(caps.capabilities.per_agent_model_selection?.state).toBe("available");
    });

    it("inspects LLM provider models from language_models configuration", async () => {
      const zedDir = path.join(workspaceDir, ".zed");
      await fsp.mkdir(zedDir, { recursive: true });
      await fsp.writeFile(
        path.join(zedDir, "settings.json"),
        JSON.stringify({
          language_models: {
            openai: {
              available_models: ["gpt-4o", "gpt-4o-mini"],
            },
            ollama: {
              available_models: [{ name: "llama3", display_name: "Llama 3 8B" }],
            },
          },
        }),
        "utf-8"
      );

      const adapter = new ZedAdapter();
      const models = await adapter.inspectModels(workspaceDir);
      expect(models.map((m) => m.id)).toContain("gpt-4o");
      expect(models.map((m) => m.id)).toContain("gpt-4o-mini");
      expect(models.map((m) => m.id)).toContain("llama3");
    });

    it("reports subagents as unknown when assistant profiles are absent", async () => {
      const adapter = new ZedAdapter();
      const caps = await adapter.inspectCapabilities(workspaceDir);
      expect(caps.capabilities.subagents.state).toBe("unknown");
    });
  });

  describe("MCP Tools: Context Servers Lifecycle (§38)", () => {
    it("detects companion registration in context_servers of .zed/settings.json", async () => {
      const zedDir = path.join(workspaceDir, ".zed");
      await fsp.mkdir(zedDir, { recursive: true });
      await fsp.writeFile(
        path.join(zedDir, "settings.json"),
        JSON.stringify({
          context_servers: {
            "agent-config": { command: "agent-config", args: ["serve"] },
          },
        }),
        "utf-8"
      );

      const adapter = new ZedAdapter();
      const status = await adapter.inspectCompanionRegistration(workspaceDir);
      expect(status.registered).toBe(true);
    });

    it("runs complete companion registration preview, apply, and validate lifecycle", async () => {
      const adapter = new ZedAdapter();

      // Initially unregistered
      const initialStatus = await adapter.inspectCompanionRegistration(workspaceDir);
      expect(initialStatus.registered).toBe(false);

      // Preview
      const preview = await adapter.previewCompanionRegistration(workspaceDir);
      expect(preview.supported).toBe(true);
      expect(preview.mutation_targets).toHaveLength(1);
      expect(preview.diff).toContain('"context_servers"');
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
      execution: { model: "claude-3-7-sonnet", effort: "high" },
    };

    const decomposedPlan: ExecutionConfig = {
      task_shape: "decomposed",
      model_mode: "multi",
      readiness: "executable",
      topology: { type: "controller-workers", concurrency: 2 },
      controller: { model: "claude-3-7-sonnet" },
      work_items: [
        {
          ticket_id: "worker-ticket",
          difficulty: "routine",
          model: "claude-3-5-haiku",
        },
      ],
    };

    it("renders and applies single-pass configuration to .zed/settings.json preserving provider", async () => {
      const zedDir = path.join(workspaceDir, ".zed");
      await fsp.mkdir(zedDir, { recursive: true });
      await fsp.writeFile(
        path.join(zedDir, "settings.json"),
        JSON.stringify({
          assistant: {
            default_model: {
              provider: "anthropic",
              model: "claude-3-5-sonnet",
            },
          },
        }),
        "utf-8"
      );

      const adapter = new ZedAdapter();
      const rendered = await adapter.renderConfiguration(singlePlan, undefined, workspaceDir);

      expect(rendered.mutation_targets[0]).toBe(
        path.join(workspaceDir, ".zed", "settings.json")
      );
      expect(rendered.diff).toContain('"claude-3-7-sonnet"');
      expect((rendered.raw as any)?.configured_agent_path).toBe("zed-agent");

      const apply = await adapter.applyConfiguration(rendered.preview_id, rendered, workspaceDir);
      expect(apply.success).toBe(true);

      const content = await fsp.readFile(
        path.join(workspaceDir, ".zed", "settings.json"),
        "utf-8"
      );
      const parsed = JSON.parse(content);
      expect(parsed.assistant?.default_model?.provider).toBe("anthropic");
      expect(parsed.assistant?.default_model?.model).toBe("claude-3-7-sonnet");

      const validation = await adapter.validateConfiguration(singlePlan, workspaceDir);
      expect(validation.valid).toBe(true);
      expect((validation.details as any).agent_path).toBe("zed-agent");
    });

    it("renders and applies decomposed plan updating assistant.profiles in .zed/settings.json", async () => {
      const adapter = new ZedAdapter();
      const rendered = await adapter.renderConfiguration(decomposedPlan, undefined, workspaceDir);

      const apply = await adapter.applyConfiguration(rendered.preview_id, rendered, workspaceDir);
      expect(apply.success).toBe(true);

      const content = await fsp.readFile(
        path.join(workspaceDir, ".zed", "settings.json"),
        "utf-8"
      );
      const parsed = JSON.parse(content);
      expect(parsed.assistant?.profiles?.["worker-ticket"]?.model).toBe("claude-3-5-haiku");

      const validation = await adapter.validateConfiguration(decomposedPlan, workspaceDir);
      expect(validation.valid).toBe(true);

      // Detect drift
      parsed.assistant.profiles["worker-ticket"].model = "drifted-model";
      await fsp.writeFile(
        path.join(workspaceDir, ".zed", "settings.json"),
        JSON.stringify(parsed),
        "utf-8"
      );
      const driftValidation = await adapter.validateConfiguration(decomposedPlan, workspaceDir);
      expect(driftValidation.valid).toBe(false);
    });

    it("fails closed on malformed existing settings", async () => {
      const zedDir = path.join(workspaceDir, ".zed");
      await fsp.mkdir(zedDir, { recursive: true });
      await fsp.writeFile(
        path.join(zedDir, "settings.json"),
        "{ broken json content",
        "utf-8"
      );

      const adapter = new ZedAdapter();
      await expect(
        adapter.renderConfiguration(singlePlan, undefined, workspaceDir)
      ).rejects.toThrow(/syntax error/i);
    });
  });
});
