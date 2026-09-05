import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { CursorAdapter } from "../../src/adapters/cursor/index.js";
import { ExecutionConfig } from "../../src/profile/schema.js";
import { createMockSubprocessRunner, MockSubprocessRunner } from "../harness/mock-runner.js";

describe("Cursor Native Adapter Tests (§36)", () => {
  let tempDir: string;
  let workspaceDir: string;
  let userHomeDir: string;
  let originalHome: string | undefined;
  let originalEnv: Record<string, string | undefined>;
  let mockRunner: MockSubprocessRunner;

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "cursor-test-"));
    workspaceDir = path.join(tempDir, "workspace");
    userHomeDir = path.join(tempDir, "home");
    await fsp.mkdir(workspaceDir, { recursive: true });
    await fsp.mkdir(userHomeDir, { recursive: true });

    mockRunner = createMockSubprocessRunner();
    mockRunner.installGlobalHook();

    originalHome = process.env.HOME;
    originalEnv = {
      CURSOR_CLI: process.env.CURSOR_CLI,
      CURSOR_AGENT: process.env.CURSOR_AGENT,
      CURSOR_SESSION_ID: process.env.CURSOR_SESSION_ID,
      CURSOR_PROJECT_DIR: process.env.CURSOR_PROJECT_DIR,
      CURSOR_CONFIG_DIR: process.env.CURSOR_CONFIG_DIR,
      CURSOR_VERSION: process.env.CURSOR_VERSION,
      CURSOR_CLI_VERSION: process.env.CURSOR_CLI_VERSION,
      CURSOR_MODEL: process.env.CURSOR_MODEL,
      CURSOR_REASONING_EFFORT: process.env.CURSOR_REASONING_EFFORT,
      CURSOR_PARALLEL_AGENTS: process.env.CURSOR_PARALLEL_AGENTS,
      CURSOR_HEADLESS: process.env.CURSOR_HEADLESS,
      CURSOR_NON_INTERACTIVE: process.env.CURSOR_NON_INTERACTIVE,
      CI: process.env.CI,
    };

    process.env.HOME = userHomeDir;
    delete process.env.CURSOR_CLI;
    delete process.env.CURSOR_AGENT;
    delete process.env.CURSOR_SESSION_ID;
    delete process.env.CURSOR_PROJECT_DIR;
    delete process.env.CURSOR_CONFIG_DIR;
    delete process.env.CURSOR_VERSION;
    delete process.env.CURSOR_CLI_VERSION;
    delete process.env.CURSOR_MODEL;
    delete process.env.CURSOR_REASONING_EFFORT;
    delete process.env.CURSOR_PARALLEL_AGENTS;
    delete process.env.CURSOR_HEADLESS;
    delete process.env.CURSOR_NON_INTERACTIVE;
    delete process.env.CI;
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

  describe("Host Identification & Runtime Context", () => {
    it("identifies Cursor from environment variables", async () => {
      const adapter = new CursorAdapter();
      expect(adapter.hasActiveRuntimeContext(workspaceDir)).toBe(false);

      process.env.CURSOR_CLI = "1";
      expect(adapter.hasActiveRuntimeContext(workspaceDir)).toBe(true);
      expect(await adapter.identifyHost(workspaceDir)).toBe(true);

      delete process.env.CURSOR_CLI;
      process.env.CURSOR_AGENT = "1";
      expect(adapter.hasActiveRuntimeContext(workspaceDir)).toBe(true);
      expect(await adapter.identifyHost(workspaceDir)).toBe(true);
    });

    it("identifies Cursor from workspace .cursor directory", async () => {
      const adapter = new CursorAdapter();
      expect(await adapter.identifyHost(workspaceDir)).toBe(false);

      await fsp.mkdir(path.join(workspaceDir, ".cursor"), { recursive: true });
      expect(await adapter.identifyHost(workspaceDir)).toBe(true);
    });

    it("identifies Cursor from workspace .cursorrules file", async () => {
      const adapter = new CursorAdapter();
      await fsp.writeFile(path.join(workspaceDir, ".cursorrules"), "# Cursor Rules\n", "utf-8");
      expect(await adapter.identifyHost(workspaceDir)).toBe(true);
    });

    it("identifies Cursor from user ~/.cursor directory when no workspace supplied", async () => {
      const adapter = new CursorAdapter();
      await fsp.mkdir(path.join(userHomeDir, ".cursor"), { recursive: true });
      expect(await adapter.identifyHost()).toBe(true);
    });
  });

  describe("Headless Execution Detection", () => {
    it("detects headless mode from CURSOR_HEADLESS or CURSOR_NON_INTERACTIVE", () => {
      const adapter = new CursorAdapter();
      expect(adapter.isHeadlessExecution(workspaceDir)).toBe(false);

      process.env.CURSOR_HEADLESS = "1";
      expect(adapter.isHeadlessExecution(workspaceDir)).toBe(true);

      delete process.env.CURSOR_HEADLESS;
      process.env.CURSOR_NON_INTERACTIVE = "1";
      expect(adapter.isHeadlessExecution(workspaceDir)).toBe(true);

      delete process.env.CURSOR_NON_INTERACTIVE;
      process.env.CI = "true";
      expect(adapter.isHeadlessExecution(workspaceDir)).toBe(true);
    });
  });

  describe("Version Inspection & Compatibility", () => {
    it("reports unknown-version and fails closed when unevidenced", async () => {
      const adapter = new CursorAdapter();
      const version = await adapter.inspectVersion(workspaceDir);
      expect(version.compatibility).toBe("unknown-version");
      expect(version.fail_closed_for_mutation).toBe(true);
    });

    it("detects supported version from cursor --version CLI output", async () => {
      mockRunner.register("cursor", {
        exitCode: 0,
        stdout: "0.45.11\n7b61f8a85c8a002bc0f70dbddbc02a24",
      });

      const adapter = new CursorAdapter();
      const version = await adapter.inspectVersion(workspaceDir);
      expect(version.compatibility).toBe("supported");
      expect(version.version).toBe("0.45.11");
      expect(version.fail_closed_for_mutation).toBe(false);
    });

    it("detects supported version from CURSOR_VERSION env", async () => {
      process.env.CURSOR_VERSION = "0.44.0";
      const adapter = new CursorAdapter();
      const version = await adapter.inspectVersion(workspaceDir);
      expect(version.compatibility).toBe("supported");
      expect(version.version).toBe("0.44.0");
      expect(version.fail_closed_for_mutation).toBe(false);
    });

    it("detects version from .cursor/version", async () => {
      const dir = path.join(workspaceDir, ".cursor");
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(path.join(dir, "version"), "0.42.3\n", "utf-8");

      const adapter = new CursorAdapter();
      const version = await adapter.inspectVersion(workspaceDir);
      expect(version.compatibility).toBe("supported");
      expect(version.version).toBe("0.42.3");
    });

    it("detects incompatible version", async () => {
      process.env.CURSOR_VERSION = "incompatible";
      const adapter = new CursorAdapter();
      const version = await adapter.inspectVersion(workspaceDir);
      expect(version.compatibility).toBe("incompatible");
      expect(version.fail_closed_for_mutation).toBe(true);
    });
  });

  describe("MCP Status: Host CLI Command Prioritization vs Config File Fallback (§36)", () => {
    it("prioritizes host CLI inspection command when available", async () => {
      // CLI command returns configured agent-config MCP server
      mockRunner.register(
        "cursor",
        {
          exitCode: 0,
          stdout: JSON.stringify({
            mcpServers: {
              "agent-config": {
                command: "agent-config",
                args: ["serve"],
              },
            },
          }),
        },
        ["mcp", "list", "--json"]
      );

      // Workspace config has NO mcp.json file
      const adapter = new CursorAdapter();
      const status = await adapter.inspectCompanionRegistration(workspaceDir);

      expect(status.registered).toBe(true);
      expect(status.command).toBe("agent-config");
      expect((status.details as any)?.source).toBe("host-command");
    });

    it("falls back cleanly to workspace .cursor/mcp.json when CLI command is unavailable", async () => {
      // CLI command fails / not found
      mockRunner.register("cursor", {
        exitCode: 127,
        stderr: "cursor: command not found",
      });

      const dir = path.join(workspaceDir, ".cursor");
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(
        path.join(dir, "mcp.json"),
        JSON.stringify({
          mcpServers: {
            "agent-config": {
              command: "agent-config",
              args: ["serve"],
            },
          },
        }),
        "utf-8"
      );

      const adapter = new CursorAdapter();
      const status = await adapter.inspectCompanionRegistration(workspaceDir);

      expect(status.registered).toBe(true);
      expect(status.command).toBe("agent-config");
      expect((status.details as any)?.source).toBe("workspace-config");
      expect(status.target_file).toBe(path.join(dir, "mcp.json"));
    });

    it("falls back to global ~/.cursor/mcp.json when project config is absent", async () => {
      const userCursorDir = path.join(userHomeDir, ".cursor");
      await fsp.mkdir(userCursorDir, { recursive: true });
      await fsp.writeFile(
        path.join(userCursorDir, "mcp.json"),
        JSON.stringify({
          mcpServers: {
            "agent-config": {
              command: "agent-config",
              args: ["serve"],
            },
          },
        }),
        "utf-8"
      );

      const adapter = new CursorAdapter();
      const status = await adapter.inspectCompanionRegistration(workspaceDir);

      expect(status.registered).toBe(true);
      expect((status.details as any)?.source).toBe("user-config");
      expect(status.target_file).toBe(path.join(userCursorDir, "mcp.json"));
    });

    it("previews companion registration strictly targeting global scope when scope is global", async () => {
      const adapter = new CursorAdapter();
      const preview = await adapter.previewCompanionRegistration(workspaceDir, "global");

      expect(preview.supported).toBe(true);
      expect(preview.scope).toBe("global");
      expect(preview.target_file).toBe(path.join(userHomeDir, ".cursor", "mcp.json"));
      expect(preview.mutation_targets).toContain(path.join(userHomeDir, ".cursor", "mcp.json"));
      expect(preview.preview_hash).toBeDefined();
    });
  });

  describe("Model Controls & Settings Hierarchy", () => {
    it("returns empty array when no models are evidenced", async () => {
      const adapter = new CursorAdapter();
      const models = await adapter.inspectModels(workspaceDir);
      expect(models).toEqual([]);
    });

    it("inspects cursor.model and cursor.models from .cursor/settings.json", async () => {
      const dir = path.join(workspaceDir, ".cursor");
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(
        path.join(dir, "settings.json"),
        JSON.stringify({
          "cursor.model": "claude-3-7-sonnet",
          "cursor.models": ["claude-3-7-sonnet", "gpt-4o"],
        }),
        "utf-8"
      );

      const adapter = new CursorAdapter();
      const models = await adapter.inspectModels(workspaceDir);
      const ids = models.map((m) => m.id);
      expect(ids).toContain("claude-3-7-sonnet");
      expect(ids).toContain("gpt-4o");

      const caps = await adapter.inspectCapabilities(workspaceDir);
      expect(caps.capabilities.model_selection.state).toBe("available");
    });

    it("project scope settings override user scope settings", async () => {
      // User settings
      const userCursorDir = path.join(userHomeDir, ".cursor");
      await fsp.mkdir(userCursorDir, { recursive: true });
      await fsp.writeFile(
        path.join(userCursorDir, "settings.json"),
        JSON.stringify({ "cursor.model": "gpt-4o" }),
        "utf-8"
      );

      // Workspace settings
      const wsCursorDir = path.join(workspaceDir, ".cursor");
      await fsp.mkdir(wsCursorDir, { recursive: true });
      await fsp.writeFile(
        path.join(wsCursorDir, "settings.json"),
        JSON.stringify({ "cursor.model": "claude-3-7-sonnet" }),
        "utf-8"
      );

      const adapter = new CursorAdapter();
      const effective = adapter.readEffectiveSettings(workspaceDir);
      expect(effective?.isProject).toBe(true);
      expect(effective?.settings["cursor.model"]).toBe("claude-3-7-sonnet");
    });
  });

  describe("Subagent / Background & Parallel Agent Capabilities", () => {
    it("reports unknown when parallel agent capabilities are unconfirmed", async () => {
      const adapter = new CursorAdapter();
      const caps = await adapter.inspectCapabilities(workspaceDir);

      expect(caps.capabilities.subagents.state).toBe("unknown");
      expect(caps.capabilities.parallelism.state).toBe("unknown");
      expect(caps.capabilities.threads.state).toBe("unknown");

      const topology = await adapter.inspectExecutionTopologyCapabilities(workspaceDir);
      expect(topology.supports_single_session).toBe(true);
      expect(topology.supports_subagents).toBe(false);
      expect(topology.supports_parallel_execution).toBe(false);
      expect(topology.max_concurrency).toBe(1);
    });

    it("reports available when cursor.parallelAgents is enabled in settings", async () => {
      const dir = path.join(workspaceDir, ".cursor");
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(
        path.join(dir, "settings.json"),
        JSON.stringify({
          "cursor.model": "claude-3-7-sonnet",
          "cursor.parallelAgents": true,
          "cursor.maxConcurrency": 4,
        }),
        "utf-8"
      );

      const adapter = new CursorAdapter();
      const caps = await adapter.inspectCapabilities(workspaceDir);

      expect(caps.capabilities.subagents.state).toBe("available");
      expect(caps.capabilities.parallelism.state).toBe("available");
      expect(caps.capabilities.concurrency?.state).toBe("available");
      expect(caps.capabilities.concurrency?.max_concurrency).toBe(4);

      const topology = await adapter.inspectExecutionTopologyCapabilities(workspaceDir);
      expect(topology.supports_single_session).toBe(true);
      expect(topology.supports_subagents).toBe(true);
      expect(topology.supports_parallel_execution).toBe(true);
      expect(topology.max_concurrency).toBe(4);
    });
  });

  describe("Companion MCP Registration Lifecycle", () => {
    it("manages Cursor companion registration lifecycle", async () => {
      const adapter = new CursorAdapter();

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
        path.join(workspaceDir, ".cursor", "mcp.json"),
        "utf-8"
      );
      expect(content).toContain('"agent-config"');
      expect(content).toContain('"command": "agent-config"');
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

    it("renders, applies, and validates configuration into .cursor/settings.json", async () => {
      const adapter = new CursorAdapter();
      const rendered = await adapter.renderConfiguration(singlePlan, undefined, workspaceDir);

      expect(rendered.mutation_targets[0]).toBe(
        path.join(workspaceDir, ".cursor", "settings.json")
      );
      expect(rendered.diff).toContain('"cursor.model": "claude-3-7-sonnet"');

      const apply = await adapter.applyConfiguration(rendered.preview_id, rendered, workspaceDir);
      expect(apply.success).toBe(true);

      const validation = await adapter.validateConfiguration(singlePlan, workspaceDir);
      expect(validation.valid).toBe(true);

      // Tamper to check drift
      await fsp.writeFile(
        path.join(workspaceDir, ".cursor", "settings.json"),
        JSON.stringify({ "cursor.model": "different-model" }),
        "utf-8"
      );
      const driftValidation = await adapter.validateConfiguration(singlePlan, workspaceDir);
      expect(driftValidation.valid).toBe(false);
      expect(driftValidation.errors?.some((e) => e.includes("Model mismatch"))).toBe(true);
    });
  });
});
