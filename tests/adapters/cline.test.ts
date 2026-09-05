import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ClineAdapter } from "../../src/adapters/cline/index.js";
import { ExecutionConfig } from "../../src/profile/schema.js";
import { createMockSubprocessRunner, MockSubprocessRunner } from "../harness/mock-runner.js";

describe("Cline Native Adapter Tests (P1)", () => {
  let tempDir: string;
  let workspaceDir: string;
  let userHomeDir: string;
  let originalHome: string | undefined;
  let originalEnv: Record<string, string | undefined>;
  let mockRunner: MockSubprocessRunner;

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "cline-adapter-test-"));
    workspaceDir = path.join(tempDir, "workspace");
    userHomeDir = path.join(tempDir, "home");
    await fsp.mkdir(workspaceDir, { recursive: true });
    await fsp.mkdir(userHomeDir, { recursive: true });

    mockRunner = createMockSubprocessRunner();
    mockRunner.installGlobalHook();

    originalHome = process.env.HOME;
    originalEnv = {
      CLINE_CLI: process.env.CLINE_CLI,
      CLINE_AGENT: process.env.CLINE_AGENT,
      CLINE_SESSION: process.env.CLINE_SESSION,
      CLINE_SESSION_ID: process.env.CLINE_SESSION_ID,
      CLINE_PROJECT_DIR: process.env.CLINE_PROJECT_DIR,
      CLINE_CONFIG_DIR: process.env.CLINE_CONFIG_DIR,
      CLINE_VERSION: process.env.CLINE_VERSION,
      CLINE_CLI_VERSION: process.env.CLINE_CLI_VERSION,
      CLINE_MODEL: process.env.CLINE_MODEL,
      CLINE_REASONING_EFFORT: process.env.CLINE_REASONING_EFFORT,
      CLINE_MAX_CONCURRENCY: process.env.CLINE_MAX_CONCURRENCY,
    };

    process.env.HOME = userHomeDir;
    delete process.env.CLINE_CLI;
    delete process.env.CLINE_AGENT;
    delete process.env.CLINE_SESSION;
    delete process.env.CLINE_SESSION_ID;
    delete process.env.CLINE_PROJECT_DIR;
    delete process.env.CLINE_CONFIG_DIR;
    delete process.env.CLINE_VERSION;
    delete process.env.CLINE_CLI_VERSION;
    delete process.env.CLINE_MODEL;
    delete process.env.CLINE_REASONING_EFFORT;
    delete process.env.CLINE_MAX_CONCURRENCY;
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
    it("identifies Cline from environment variables", async () => {
      const adapter = new ClineAdapter();
      expect(adapter.hasActiveRuntimeContext(workspaceDir)).toBe(false);

      process.env.CLINE_AGENT = "1";
      expect(adapter.hasActiveRuntimeContext(workspaceDir)).toBe(true);
      expect(await adapter.identifyHost(workspaceDir)).toBe(true);

      delete process.env.CLINE_AGENT;
      process.env.CLINE_CLI = "true";
      expect(adapter.hasActiveRuntimeContext(workspaceDir)).toBe(true);
      expect(await adapter.identifyHost(workspaceDir)).toBe(true);
    });

    it("identifies Cline from workspace markers (.cline, .clinerules)", async () => {
      const adapter = new ClineAdapter();
      expect(await adapter.identifyHost(workspaceDir)).toBe(false);

      const rulesFile = path.join(workspaceDir, ".clinerules");
      await fsp.writeFile(rulesFile, "# Cline rules", "utf-8");
      expect(await adapter.identifyHost(workspaceDir)).toBe(true);

      await fsp.rm(rulesFile, { force: true });
      expect(await adapter.identifyHost(workspaceDir)).toBe(false);

      await fsp.mkdir(path.join(workspaceDir, ".cline"), { recursive: true });
      expect(await adapter.identifyHost(workspaceDir)).toBe(true);
    });

    it("identifies Cline from user home storage when workspaceRoot is omitted", async () => {
      const adapter = new ClineAdapter();
      expect(await adapter.identifyHost()).toBe(false);

      const userDir = path.join(
        userHomeDir,
        ".config",
        "Code",
        "User",
        "globalStorage",
        "saoudrizwan.claude-dev",
        "settings"
      );
      await fsp.mkdir(userDir, { recursive: true });
      await fsp.writeFile(path.join(userDir, "cline_mcp_settings.json"), "{}", "utf-8");
      expect(await adapter.identifyHost()).toBe(true);
    });
  });

  describe("Version Detection & Fail-Closed Semantics", () => {
    it("returns unknown-version with fail_closed_for_mutation: true when unevidenced", async () => {
      const adapter = new ClineAdapter();
      const version = await adapter.inspectVersion(workspaceDir);
      expect(version.compatibility).toBe("unknown-version");
      expect(version.fail_closed_for_mutation).toBe(true);
    });

    it("detects version from workspace .cline/version", async () => {
      const clineDir = path.join(workspaceDir, ".cline");
      await fsp.mkdir(clineDir, { recursive: true });
      await fsp.writeFile(path.join(clineDir, "version"), "2.1.0\n", "utf-8");

      const adapter = new ClineAdapter();
      const version = await adapter.inspectVersion(workspaceDir);
      expect(version.version).toBe("2.1.0");
      expect(version.compatibility).toBe("partially-supported");
      expect(version.fail_closed_for_mutation).toBe(false);
    });

    it("detects version from CLI execution via mockRunner", async () => {
      mockRunner.register("cline", {
        exitCode: 0,
        stdout: "cline 1.9.0\n",
      });

      const adapter = new ClineAdapter();
      const version = await adapter.inspectVersion(workspaceDir);
      expect(version.version).toBe("1.9.0");
      expect(version.compatibility).toBe("supported");
      expect(version.fail_closed_for_mutation).toBe(false);
    });
  });

  describe("Capabilities & Anti-Guessing Invariants", () => {
    it("reports unknown for unconfirmed capabilities without inventing models or effort", async () => {
      const adapter = new ClineAdapter();
      const caps = await adapter.inspectCapabilities(workspaceDir);

      expect(caps.host_id).toBe("cline");
      expect(caps.adapter_id).toBe("cline");
      expect(caps.available_models).toEqual([]);
      expect(caps.supported_effort_values).toEqual([]);
      expect(caps.capabilities.subagents.state).toBe("unknown");
      expect(caps.capabilities.threads.state).toBe("unknown");
      expect(caps.capabilities.parallelism.state).toBe("unknown");
      expect(caps.capabilities.concurrency?.state).toBe("unknown");
      expect(caps.capabilities.reasoning?.state).toBe("unknown");
    });

    it("detects subagents when .clinerules or .roomodes exists", async () => {
      await fsp.writeFile(path.join(workspaceDir, ".clinerules"), "custom rules", "utf-8");

      const adapter = new ClineAdapter();
      const caps = await adapter.inspectCapabilities(workspaceDir);
      expect(caps.capabilities.subagents.state).toBe("available");
      expect(caps.capabilities.per_agent_model_selection?.state).toBe("available");
    });

    it("detects models and effort values from .cline/settings.json", async () => {
      const clineDir = path.join(workspaceDir, ".cline");
      await fsp.mkdir(clineDir, { recursive: true });
      await fsp.writeFile(
        path.join(clineDir, "settings.json"),
        JSON.stringify({
          apiConfiguration: {
            apiModelId: "claude-3-7-sonnet",
            thinkingBudget: "high",
          },
          supported_effort_values: ["low", "medium", "high"],
        }),
        "utf-8"
      );

      const adapter = new ClineAdapter();
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
      process.env.CLINE_MAX_CONCURRENCY = "3";
      const adapter = new ClineAdapter();
      const caps = await adapter.inspectCapabilities(workspaceDir);

      expect(caps.capabilities.concurrency?.state).toBe("available");
      expect(caps.capabilities.concurrency?.max_concurrency).toBe(3);
      expect(caps.capabilities.parallelism.state).toBe("available");
    });
  });

  describe("MCP Companion Registration Lifecycle", () => {
    it("correctly detects unregistered, previews diff, applies atomically, and validates", async () => {
      const adapter = new ClineAdapter();
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
      const adapter = new ClineAdapter();
      const plan: ExecutionConfig = {
        execution_id: "cline-plan-1",
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
