import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { GeminiCliAdapter } from "../../src/adapters/gemini-cli/index.js";
import { ExecutionConfig } from "../../src/profile/schema.js";

describe("Gemini CLI Native Adapter Tests (§33)", () => {
  let tempDir: string;
  let workspaceDir: string;
  let userHomeDir: string;
  let originalHome: string | undefined;
  let originalEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "gemini-cli-test-"));
    workspaceDir = path.join(tempDir, "workspace");
    userHomeDir = path.join(tempDir, "home");
    await fsp.mkdir(workspaceDir, { recursive: true });
    await fsp.mkdir(userHomeDir, { recursive: true });

    originalHome = process.env.HOME;
    originalEnv = {
      GEMINI_CLI: process.env.GEMINI_CLI,
      GEMINI_PROJECT_DIR: process.env.GEMINI_PROJECT_DIR,
      GEMINI_SESSION_ID: process.env.GEMINI_SESSION_ID,
      GEMINI_CONFIG_DIR: process.env.GEMINI_CONFIG_DIR,
      GEMINI_HOME: process.env.GEMINI_HOME,
      GEMINI_CLI_VERSION: process.env.GEMINI_CLI_VERSION,
      GEMINI_VERSION: process.env.GEMINI_VERSION,
      GEMINI_MODEL: process.env.GEMINI_MODEL,
      GEMINI_REASONING_EFFORT: process.env.GEMINI_REASONING_EFFORT,
      GEMINI_HEADLESS: process.env.GEMINI_HEADLESS,
      GEMINI_NON_INTERACTIVE: process.env.GEMINI_NON_INTERACTIVE,
      CI: process.env.CI,
    };

    process.env.HOME = userHomeDir;
    delete process.env.GEMINI_CLI;
    delete process.env.GEMINI_PROJECT_DIR;
    delete process.env.GEMINI_SESSION_ID;
    delete process.env.GEMINI_CONFIG_DIR;
    delete process.env.GEMINI_HOME;
    delete process.env.GEMINI_CLI_VERSION;
    delete process.env.GEMINI_VERSION;
    delete process.env.GEMINI_MODEL;
    delete process.env.GEMINI_REASONING_EFFORT;
    delete process.env.GEMINI_HEADLESS;
    delete process.env.GEMINI_NON_INTERACTIVE;
    delete process.env.CI;
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
    it("identifies Gemini CLI from environment variables", async () => {
      const adapter = new GeminiCliAdapter();
      expect(adapter.hasActiveRuntimeContext(workspaceDir)).toBe(false);

      process.env.GEMINI_CLI = "1";
      expect(adapter.hasActiveRuntimeContext(workspaceDir)).toBe(true);
      expect(await adapter.identifyHost(workspaceDir)).toBe(true);

      delete process.env.GEMINI_CLI;
      process.env.GEMINI_PROJECT_DIR = workspaceDir;
      expect(adapter.hasActiveRuntimeContext(workspaceDir)).toBe(true);
      expect(await adapter.identifyHost(workspaceDir)).toBe(true);
    });

    it("identifies Gemini CLI from workspace .gemini directory", async () => {
      const adapter = new GeminiCliAdapter();
      expect(await adapter.identifyHost(workspaceDir)).toBe(false);

      await fsp.mkdir(path.join(workspaceDir, ".gemini"), { recursive: true });
      expect(await adapter.identifyHost(workspaceDir)).toBe(true);
    });

    it("identifies Gemini CLI from workspace gemini.json file", async () => {
      const adapter = new GeminiCliAdapter();
      await fsp.writeFile(path.join(workspaceDir, "gemini.json"), "{}", "utf-8");
      expect(await adapter.identifyHost(workspaceDir)).toBe(true);
    });

    it("identifies Gemini CLI from user ~/.gemini directory when no workspace supplied", async () => {
      const adapter = new GeminiCliAdapter();
      await fsp.mkdir(path.join(userHomeDir, ".gemini"), { recursive: true });
      expect(await adapter.identifyHost()).toBe(true);
    });
  });

  describe("Headless Execution Detection", () => {
    it("detects headless mode from GEMINI_HEADLESS or GEMINI_NON_INTERACTIVE", () => {
      const adapter = new GeminiCliAdapter();
      expect(adapter.isHeadlessExecution(workspaceDir)).toBe(false);

      process.env.GEMINI_HEADLESS = "1";
      expect(adapter.isHeadlessExecution(workspaceDir)).toBe(true);

      delete process.env.GEMINI_HEADLESS;
      process.env.GEMINI_NON_INTERACTIVE = "1";
      expect(adapter.isHeadlessExecution(workspaceDir)).toBe(true);

      delete process.env.GEMINI_NON_INTERACTIVE;
      process.env.CI = "true";
      expect(adapter.isHeadlessExecution(workspaceDir)).toBe(true);
    });
  });

  describe("Version Inspection & Compatibility", () => {
    it("reports unknown-version and fails closed when unevidenced", async () => {
      const adapter = new GeminiCliAdapter();
      const version = await adapter.inspectVersion(workspaceDir);
      expect(version.compatibility).toBe("unknown-version");
      expect(version.fail_closed_for_mutation).toBe(true);
    });

    it("detects supported version from GEMINI_CLI_VERSION env", async () => {
      process.env.GEMINI_CLI_VERSION = "1.0.4";
      const adapter = new GeminiCliAdapter();
      const version = await adapter.inspectVersion(workspaceDir);
      expect(version.compatibility).toBe("supported");
      expect(version.fail_closed_for_mutation).toBe(false);
      expect(version.version).toBe("1.0.4");
    });

    it("detects version from .gemini/version", async () => {
      const dir = path.join(workspaceDir, ".gemini");
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(path.join(dir, "version"), "2.0.1\n", "utf-8");

      const adapter = new GeminiCliAdapter();
      const version = await adapter.inspectVersion(workspaceDir);
      expect(version.compatibility).toBe("supported");
      expect(version.version).toBe("2.0.1");
    });

    it("detects incompatible version", async () => {
      process.env.GEMINI_VERSION = "incompatible";
      const adapter = new GeminiCliAdapter();
      const version = await adapter.inspectVersion(workspaceDir);
      expect(version.compatibility).toBe("incompatible");
      expect(version.fail_closed_for_mutation).toBe(true);
    });
  });

  describe("Tri-state Capabilities & Unavailable Subagents (§33)", () => {
    it("marks child agents and per-worker model controls honestly as unavailable", async () => {
      const adapter = new GeminiCliAdapter();
      const caps = await adapter.inspectCapabilities(workspaceDir);

      expect(caps.capabilities.subagents.state).toBe("unavailable");
      expect(caps.capabilities.per_agent_model_selection?.state).toBe("unavailable");
      expect(caps.capabilities.threads.state).toBe("unavailable");
      expect(caps.capabilities.parallelism.state).toBe("unavailable");
      expect(caps.capabilities.concurrency?.state).toBe("unavailable");
      expect(caps.capabilities.concurrency?.max_concurrency).toBe(1);

      const topology = await adapter.inspectExecutionTopologyCapabilities(workspaceDir);
      expect(topology.supports_single_session).toBe(true);
      expect(topology.supports_subagents).toBe(false);
      expect(topology.supports_parallel_execution).toBe(false);
      expect(topology.max_concurrency).toBe(1);
    });
  });

  describe("Model Selection & Settings Hierarchy", () => {
    it("returns empty array when no models are evidenced", async () => {
      const adapter = new GeminiCliAdapter();
      const models = await adapter.inspectModels(workspaceDir);
      expect(models).toEqual([]);
    });

    it("inspects single model and fallback model from .gemini/config.json", async () => {
      const dir = path.join(workspaceDir, ".gemini");
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(
        path.join(dir, "config.json"),
        JSON.stringify({
          model: "gemini-2.0-flash",
          fallback_model: "gemini-2.0-pro",
          available_models: ["gemini-2.0-flash", "gemini-2.0-pro"],
        }),
        "utf-8"
      );

      const adapter = new GeminiCliAdapter();
      const models = await adapter.inspectModels(workspaceDir);
      const ids = models.map((m) => m.id);
      expect(ids).toContain("gemini-2.0-flash");
      expect(ids).toContain("gemini-2.0-pro");

      const caps = await adapter.inspectCapabilities(workspaceDir);
      expect(caps.capabilities.model_selection.state).toBe("available");
    });

    it("project scope configuration overrides user scope configuration", async () => {
      // User config
      const userGeminiDir = path.join(userHomeDir, ".gemini");
      await fsp.mkdir(userGeminiDir, { recursive: true });
      await fsp.writeFile(
        path.join(userGeminiDir, "config.json"),
        JSON.stringify({ model: "gemini-1.5-flash" }),
        "utf-8"
      );

      // Workspace config
      const wsGeminiDir = path.join(workspaceDir, ".gemini");
      await fsp.mkdir(wsGeminiDir, { recursive: true });
      await fsp.writeFile(
        path.join(wsGeminiDir, "config.json"),
        JSON.stringify({ model: "gemini-2.0-flash" }),
        "utf-8"
      );

      const adapter = new GeminiCliAdapter();
      const effective = adapter.readEffectiveConfig(workspaceDir);
      expect(effective?.isProject).toBe(true);
      expect(effective?.config.model).toBe("gemini-2.0-flash");
    });
  });

  describe("Reasoning Controls", () => {
    it("reports unavailable reasoning when unevidenced", async () => {
      const adapter = new GeminiCliAdapter();
      const reasoning = await adapter.inspectReasoningOptions(workspaceDir);
      expect(reasoning.supported_values).toEqual([]);

      const caps = await adapter.inspectCapabilities(workspaceDir);
      expect(caps.capabilities.reasoning?.state).toBe("unavailable");
      expect(caps.supported_effort_values).toEqual([]);
    });

    it("reports available reasoning when evidenced in config", async () => {
      const dir = path.join(workspaceDir, ".gemini");
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(
        path.join(dir, "config.json"),
        JSON.stringify({ model: "gemini-2.0-flash", reasoning_effort: "high" }),
        "utf-8"
      );

      const adapter = new GeminiCliAdapter();
      const reasoning = await adapter.inspectReasoningOptions(workspaceDir);
      expect(reasoning.supported_values).toContain("low");
      expect(reasoning.supported_values).toContain("high");
      expect(reasoning.default_value).toBe("high");

      const caps = await adapter.inspectCapabilities(workspaceDir);
      expect(caps.capabilities.reasoning?.state).toBe("available");

      // Policy resolution
      const resolved = await adapter.resolveReasoningPolicy("highest-supported", undefined, workspaceDir);
      expect(resolved?.host_field).toBe("reasoning_effort");
      expect(resolved?.host_value).toBe("high");
    });
  });

  describe("MCP & Companion Registration Lifecycle", () => {
    it("manages Gemini CLI companion registration lifecycle", async () => {
      const adapter = new GeminiCliAdapter();

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

      // Check file content
      const content = await fsp.readFile(
        path.join(workspaceDir, ".gemini", "config.json"),
        "utf-8"
      );
      expect(content).toContain('"agent-config"');
      expect(content).toContain('"command": "agent-config"');
    });

    it("detects existing MCP configuration with mcp.servers", async () => {
      const dir = path.join(workspaceDir, ".gemini");
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(
        path.join(dir, "config.json"),
        JSON.stringify({
          model: "gemini-2.0-flash",
          mcp: {
            servers: {
              "agent-config": {
                command: "agent-config",
                args: ["serve"],
              },
            },
          },
        }),
        "utf-8"
      );

      const adapter = new GeminiCliAdapter();
      const status = await adapter.inspectCompanionRegistration(workspaceDir);
      expect(status.registered).toBe(true);
      expect(status.command).toBe("agent-config");
    });
  });

  describe("Configuration Preview, Apply, and Validation Lifecycle", () => {
    const singlePlan: ExecutionConfig = {
      task_shape: "single-pass",
      model_mode: "single",
      readiness: "executable",
      topology: { type: "single-session", concurrency: 1 },
      execution: { model: "gemini-2.0-flash", effort: "high" },
    };

    it("renders, applies, and validates single-pass configuration into .gemini/config.json", async () => {
      const adapter = new GeminiCliAdapter();
      const rendered = await adapter.renderConfiguration(singlePlan, undefined, workspaceDir);

      expect(rendered.mutation_targets[0]).toBe(
        path.join(workspaceDir, ".gemini", "config.json")
      );
      expect(rendered.diff).toContain('"model": "gemini-2.0-flash"');

      const apply = await adapter.applyConfiguration(rendered.preview_id, rendered, workspaceDir);
      expect(apply.success).toBe(true);

      const validation = await adapter.validateConfiguration(singlePlan, workspaceDir);
      expect(validation.valid).toBe(true);

      // Tamper to check drift
      await fsp.writeFile(
        path.join(workspaceDir, ".gemini", "config.json"),
        JSON.stringify({ model: "different-model" }),
        "utf-8"
      );
      const driftValidation = await adapter.validateConfiguration(singlePlan, workspaceDir);
      expect(driftValidation.valid).toBe(false);
      expect(driftValidation.errors?.some((e) => e.includes("Model mismatch"))).toBe(true);
    });
  });
});
