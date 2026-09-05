import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { RooCodeAdapter } from "../../src/adapters/roo-code/index.js";
import { ExecutionConfig } from "../../src/profile/schema.js";
import { createMockSubprocessRunner, MockSubprocessRunner } from "../harness/mock-runner.js";

describe("Roo Code Native Adapter Tests (P1)", () => {
  let tempDir: string;
  let workspaceDir: string;
  let userHomeDir: string;
  let originalHome: string | undefined;
  let originalEnv: Record<string, string | undefined>;
  let mockRunner: MockSubprocessRunner;

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "roo-code-adapter-test-"));
    workspaceDir = path.join(tempDir, "workspace");
    userHomeDir = path.join(tempDir, "home");
    await fsp.mkdir(workspaceDir, { recursive: true });
    await fsp.mkdir(userHomeDir, { recursive: true });

    mockRunner = createMockSubprocessRunner();
    mockRunner.installGlobalHook();

    originalHome = process.env.HOME;
    originalEnv = {
      ROO_CODE_CLI: process.env.ROO_CODE_CLI,
      ROO_AGENT: process.env.ROO_AGENT,
      ROO_SESSION: process.env.ROO_SESSION,
      ROO_SESSION_ID: process.env.ROO_SESSION_ID,
      ROO_PROJECT_DIR: process.env.ROO_PROJECT_DIR,
      ROO_CONFIG_DIR: process.env.ROO_CONFIG_DIR,
      ROO_VERSION: process.env.ROO_VERSION,
      ROO_CODE_VERSION: process.env.ROO_CODE_VERSION,
      ROO_CLI_VERSION: process.env.ROO_CLI_VERSION,
      ROO_MODEL: process.env.ROO_MODEL,
      ROO_REASONING_EFFORT: process.env.ROO_REASONING_EFFORT,
      ROO_MAX_CONCURRENCY: process.env.ROO_MAX_CONCURRENCY,
    };

    process.env.HOME = userHomeDir;
    delete process.env.ROO_CODE_CLI;
    delete process.env.ROO_AGENT;
    delete process.env.ROO_SESSION;
    delete process.env.ROO_SESSION_ID;
    delete process.env.ROO_PROJECT_DIR;
    delete process.env.ROO_CONFIG_DIR;
    delete process.env.ROO_VERSION;
    delete process.env.ROO_CODE_VERSION;
    delete process.env.ROO_CLI_VERSION;
    delete process.env.ROO_MODEL;
    delete process.env.ROO_REASONING_EFFORT;
    delete process.env.ROO_MAX_CONCURRENCY;
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
    it("identifies Roo Code from environment variables", async () => {
      const adapter = new RooCodeAdapter();
      expect(adapter.hasActiveRuntimeContext(workspaceDir)).toBe(false);

      process.env.ROO_AGENT = "1";
      expect(adapter.hasActiveRuntimeContext(workspaceDir)).toBe(true);
      expect(await adapter.identifyHost(workspaceDir)).toBe(true);

      delete process.env.ROO_AGENT;
      process.env.ROO_CODE_CLI = "true";
      expect(adapter.hasActiveRuntimeContext(workspaceDir)).toBe(true);
      expect(await adapter.identifyHost(workspaceDir)).toBe(true);
    });

    it("identifies Roo Code from workspace markers (.roo, .roomodes)", async () => {
      const adapter = new RooCodeAdapter();
      expect(await adapter.identifyHost(workspaceDir)).toBe(false);

      const modesFile = path.join(workspaceDir, ".roomodes");
      await fsp.writeFile(modesFile, '{"customModes": []}', "utf-8");
      expect(await adapter.identifyHost(workspaceDir)).toBe(true);

      await fsp.rm(modesFile, { force: true });
      expect(await adapter.identifyHost(workspaceDir)).toBe(false);

      await fsp.mkdir(path.join(workspaceDir, ".roo"), { recursive: true });
      expect(await adapter.identifyHost(workspaceDir)).toBe(true);
    });

    it("identifies Roo Code from user home storage when workspaceRoot is omitted", async () => {
      const adapter = new RooCodeAdapter();
      expect(await adapter.identifyHost()).toBe(false);

      const userDir = path.join(
        userHomeDir,
        ".config",
        "Code",
        "User",
        "globalStorage",
        "rooveterinaryinc.roo-cline",
        "settings"
      );
      await fsp.mkdir(userDir, { recursive: true });
      await fsp.writeFile(path.join(userDir, "cline_mcp_settings.json"), "{}", "utf-8");
      expect(await adapter.identifyHost()).toBe(true);
    });
  });

  describe("Version Detection & Fail-Closed Semantics", () => {
    it("returns unknown-version with fail_closed_for_mutation: true when unevidenced", async () => {
      const adapter = new RooCodeAdapter();
      const version = await adapter.inspectVersion(workspaceDir);
      expect(version.compatibility).toBe("unknown-version");
      expect(version.fail_closed_for_mutation).toBe(true);
    });

    it("detects version from workspace .roo/version", async () => {
      const rooDir = path.join(workspaceDir, ".roo");
      await fsp.mkdir(rooDir, { recursive: true });
      await fsp.writeFile(path.join(rooDir, "version"), "3.2.0\n", "utf-8");

      const adapter = new RooCodeAdapter();
      const version = await adapter.inspectVersion(workspaceDir);
      expect(version.version).toBe("3.2.0");
      expect(version.compatibility).toBe("partially-supported");
      expect(version.fail_closed_for_mutation).toBe(false);
    });

    it("detects version from CLI execution via mockRunner", async () => {
      mockRunner.register("roo-code", {
        exitCode: 0,
        stdout: "roo-code 1.8.2\n",
      });

      const adapter = new RooCodeAdapter();
      const version = await adapter.inspectVersion(workspaceDir);
      expect(version.version).toBe("1.8.2");
      expect(version.compatibility).toBe("supported");
      expect(version.fail_closed_for_mutation).toBe(false);
    });
  });

  describe("Capabilities & Anti-Guessing Invariants", () => {
    it("reports unknown for unconfirmed capabilities without inventing models or effort", async () => {
      const adapter = new RooCodeAdapter();
      const caps = await adapter.inspectCapabilities(workspaceDir);

      expect(caps.host_id).toBe("roo-code");
      expect(caps.adapter_id).toBe("roo-code");
      expect(caps.available_models).toEqual([]);
      expect(caps.supported_effort_values).toEqual([]);
      expect(caps.capabilities.subagents.state).toBe("unknown");
      expect(caps.capabilities.threads.state).toBe("unknown");
      expect(caps.capabilities.parallelism.state).toBe("unknown");
      expect(caps.capabilities.concurrency?.state).toBe("unknown");
      expect(caps.capabilities.reasoning?.state).toBe("unknown");
    });

    it("detects subagents when .roomodes exists", async () => {
      await fsp.writeFile(path.join(workspaceDir, ".roomodes"), '{"customModes": []}', "utf-8");

      const adapter = new RooCodeAdapter();
      const caps = await adapter.inspectCapabilities(workspaceDir);
      expect(caps.capabilities.subagents.state).toBe("available");
      expect(caps.capabilities.per_agent_model_selection?.state).toBe("available");
    });

    it("detects models and effort values from .roo/settings.json", async () => {
      const rooDir = path.join(workspaceDir, ".roo");
      await fsp.mkdir(rooDir, { recursive: true });
      await fsp.writeFile(
        path.join(rooDir, "settings.json"),
        JSON.stringify({
          apiConfiguration: {
            apiModelId: "claude-3-7-sonnet",
            thinkingBudget: "high",
          },
          supported_effort_values: ["low", "medium", "high"],
        }),
        "utf-8"
      );

      const adapter = new RooCodeAdapter();
      const models = await adapter.inspectModels(workspaceDir);
      expect(models.map((m) => m.id)).toContain("claude-3-7-sonnet");

      const effortValues = await adapter.inspectEffortValues(workspaceDir);
      expect(effortValues).toEqual(["low", "medium", "high"]);

      const policy = await adapter.resolveReasoningPolicy("highest-supported", undefined, workspaceDir);
      expect(policy).toEqual({
        host_field: "apiConfiguration.thinkingBudget",
        host_value: "high",
      });
    });

    it("detects concurrency and activates parallelism only when > 1", async () => {
      process.env.ROO_MAX_CONCURRENCY = "2";
      const adapter = new RooCodeAdapter();
      const caps = await adapter.inspectCapabilities(workspaceDir);

      expect(caps.capabilities.concurrency?.state).toBe("available");
      expect(caps.capabilities.concurrency?.max_concurrency).toBe(2);
      expect(caps.capabilities.parallelism.state).toBe("available");
    });
  });

  describe("MCP Companion Registration Lifecycle", () => {
    it("correctly detects unregistered, previews diff, applies atomically, and validates", async () => {
      const adapter = new RooCodeAdapter();
      const statusBefore = await adapter.inspectCompanionRegistration(workspaceDir);
      expect(statusBefore.registered).toBe(false);

      const preview = await adapter.previewCompanionRegistration(workspaceDir);
      expect(preview.supported).toBe(true);
      expect(preview.diff).toContain("agent-config");
      expect(preview.preview_hash).toBeDefined();

      const applyRes = await adapter.applyCompanionRegistration(preview.preview_hash!, workspaceDir);
      expect(applyRes.success).toBe(true);

      const statusAfter = await adapter.inspectCompanionRegistration(workspaceDir);
      expect(statusAfter.registered).toBe(true);

      const validation = await adapter.validateCompanionRegistration(workspaceDir);
      expect(validation.valid).toBe(true);
    });
  });

  describe("Execution Configuration Lifecycle", () => {
    it("renders, applies, and validates execution configuration safely", async () => {
      const adapter = new RooCodeAdapter();
      const plan: ExecutionConfig = {
        execution_id: "roo-code-plan-1",
        controller: { model: "claude-3-7-sonnet" },
        execution: { model: "claude-3-7-sonnet", effort: "high" },
        work_items: [
          { ticket_id: "ticket-1", model: "claude-3-5-sonnet" },
        ],
      };

      const rendered = await adapter.previewConfiguration(plan, undefined, workspaceDir);
      expect(rendered.preview_id).toBeDefined();
      expect(rendered.diff).toContain("claude-3-7-sonnet");

      const applyRes = await adapter.applyConfiguration(rendered.preview_id, rendered, workspaceDir);
      expect(applyRes.success).toBe(true);

      const validation = await adapter.validateConfiguration(plan, workspaceDir);
      expect(validation.valid).toBe(true);
    });
  });
});
