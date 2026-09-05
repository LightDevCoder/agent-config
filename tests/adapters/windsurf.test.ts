import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { WindsurfAdapter } from "../../src/adapters/windsurf/index.js";
import { ExecutionConfig } from "../../src/profile/schema.js";
import { createMockSubprocessRunner, MockSubprocessRunner } from "../harness/mock-runner.js";

describe("Windsurf Native Adapter Tests (P1)", () => {
  let tempDir: string;
  let workspaceDir: string;
  let userHomeDir: string;
  let originalHome: string | undefined;
  let originalEnv: Record<string, string | undefined>;
  let mockRunner: MockSubprocessRunner;

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "windsurf-adapter-test-"));
    workspaceDir = path.join(tempDir, "workspace");
    userHomeDir = path.join(tempDir, "home");
    await fsp.mkdir(workspaceDir, { recursive: true });
    await fsp.mkdir(userHomeDir, { recursive: true });

    mockRunner = createMockSubprocessRunner();
    mockRunner.installGlobalHook();

    originalHome = process.env.HOME;
    originalEnv = {
      WINDSURF_CLI: process.env.WINDSURF_CLI,
      WINDSURF_AGENT: process.env.WINDSURF_AGENT,
      CASCADE_AGENT: process.env.CASCADE_AGENT,
      WINDSURF_SESSION_ID: process.env.WINDSURF_SESSION_ID,
      CASCADE_SESSION_ID: process.env.CASCADE_SESSION_ID,
      WINDSURF_PROJECT_DIR: process.env.WINDSURF_PROJECT_DIR,
      WINDSURF_CONFIG_DIR: process.env.WINDSURF_CONFIG_DIR,
      WINDSURF_VERSION: process.env.WINDSURF_VERSION,
      CASCADE_VERSION: process.env.CASCADE_VERSION,
      WINDSURF_CLI_VERSION: process.env.WINDSURF_CLI_VERSION,
      WINDSURF_MODEL: process.env.WINDSURF_MODEL,
      CASCADE_MODEL: process.env.CASCADE_MODEL,
      WINDSURF_REASONING_EFFORT: process.env.WINDSURF_REASONING_EFFORT,
      CASCADE_REASONING_EFFORT: process.env.CASCADE_REASONING_EFFORT,
      WINDSURF_MAX_CONCURRENCY: process.env.WINDSURF_MAX_CONCURRENCY,
    };

    process.env.HOME = userHomeDir;
    delete process.env.WINDSURF_CLI;
    delete process.env.WINDSURF_AGENT;
    delete process.env.CASCADE_AGENT;
    delete process.env.WINDSURF_SESSION_ID;
    delete process.env.CASCADE_SESSION_ID;
    delete process.env.WINDSURF_PROJECT_DIR;
    delete process.env.WINDSURF_CONFIG_DIR;
    delete process.env.WINDSURF_VERSION;
    delete process.env.CASCADE_VERSION;
    delete process.env.WINDSURF_CLI_VERSION;
    delete process.env.WINDSURF_MODEL;
    delete process.env.CASCADE_MODEL;
    delete process.env.WINDSURF_REASONING_EFFORT;
    delete process.env.CASCADE_REASONING_EFFORT;
    delete process.env.WINDSURF_MAX_CONCURRENCY;
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
    it("identifies Windsurf from environment variables", async () => {
      const adapter = new WindsurfAdapter();
      expect(adapter.hasActiveRuntimeContext(workspaceDir)).toBe(false);

      process.env.CASCADE_AGENT = "1";
      expect(adapter.hasActiveRuntimeContext(workspaceDir)).toBe(true);
      expect(await adapter.identifyHost(workspaceDir)).toBe(true);

      delete process.env.CASCADE_AGENT;
      process.env.WINDSURF_CLI = "true";
      expect(adapter.hasActiveRuntimeContext(workspaceDir)).toBe(true);
      expect(await adapter.identifyHost(workspaceDir)).toBe(true);
    });

    it("identifies Windsurf from workspace markers (.windsurf, .codeium/windsurf, .windsurfrules)", async () => {
      const adapter = new WindsurfAdapter();
      expect(await adapter.identifyHost(workspaceDir)).toBe(false);

      const rulesFile = path.join(workspaceDir, ".windsurfrules");
      await fsp.writeFile(rulesFile, "# Windsurf rules", "utf-8");
      expect(await adapter.identifyHost(workspaceDir)).toBe(true);

      await fsp.rm(rulesFile, { force: true });
      expect(await adapter.identifyHost(workspaceDir)).toBe(false);

      await fsp.mkdir(path.join(workspaceDir, ".codeium", "windsurf"), { recursive: true });
      expect(await adapter.identifyHost(workspaceDir)).toBe(true);
    });

    it("identifies Windsurf from user home configs when workspaceRoot is omitted", async () => {
      const adapter = new WindsurfAdapter();
      expect(await adapter.identifyHost()).toBe(false);

      const userDir = path.join(userHomeDir, ".codeium", "windsurf");
      await fsp.mkdir(userDir, { recursive: true });
      expect(await adapter.identifyHost()).toBe(true);
    });
  });

  describe("Version Detection & Fail-Closed Semantics", () => {
    it("returns unknown-version with fail_closed_for_mutation: true when unevidenced", async () => {
      const adapter = new WindsurfAdapter();
      const version = await adapter.inspectVersion(workspaceDir);
      expect(version.compatibility).toBe("unknown-version");
      expect(version.fail_closed_for_mutation).toBe(true);
    });

    it("detects version from workspace .windsurf/version", async () => {
      const windsurfDir = path.join(workspaceDir, ".windsurf");
      await fsp.mkdir(windsurfDir, { recursive: true });
      await fsp.writeFile(path.join(windsurfDir, "version"), "1.3.0\n", "utf-8");

      const adapter = new WindsurfAdapter();
      const version = await adapter.inspectVersion(workspaceDir);
      expect(version.version).toBe("1.3.0");
      expect(version.compatibility).toBe("supported");
      expect(version.fail_closed_for_mutation).toBe(false);
    });

    it("detects version from CLI execution via mockRunner", async () => {
      mockRunner.register("windsurf", {
        exitCode: 0,
        stdout: "windsurf 1.4.1\n",
      });

      const adapter = new WindsurfAdapter();
      const version = await adapter.inspectVersion(workspaceDir);
      expect(version.version).toBe("1.4.1");
      expect(version.compatibility).toBe("supported");
      expect(version.fail_closed_for_mutation).toBe(false);
    });

    it("marks explicit incompatible version as incompatible and fails closed", async () => {
      process.env.CASCADE_VERSION = "incompatible";
      const adapter = new WindsurfAdapter();
      const version = await adapter.inspectVersion(workspaceDir);
      expect(version.compatibility).toBe("incompatible");
      expect(version.fail_closed_for_mutation).toBe(true);
    });
  });

  describe("Capabilities & Anti-Guessing Invariants", () => {
    it("reports unknown for unconfirmed capabilities without inventing models or effort", async () => {
      const adapter = new WindsurfAdapter();
      const caps = await adapter.inspectCapabilities(workspaceDir);

      expect(caps.host_id).toBe("windsurf");
      expect(caps.adapter_id).toBe("windsurf");
      expect(caps.available_models).toEqual([]);
      expect(caps.supported_effort_values).toEqual([]);
      expect(caps.capabilities.subagents.state).toBe("unknown");
      expect(caps.capabilities.threads.state).toBe("unknown");
      expect(caps.capabilities.parallelism.state).toBe("unknown");
      expect(caps.capabilities.concurrency?.state).toBe("unknown");
      expect(caps.capabilities.reasoning?.state).toBe("unknown");
    });

    it("detects subagents when .windsurf/agents directory exists", async () => {
      const agentsDir = path.join(workspaceDir, ".windsurf", "agents");
      await fsp.mkdir(agentsDir, { recursive: true });

      const adapter = new WindsurfAdapter();
      const caps = await adapter.inspectCapabilities(workspaceDir);
      expect(caps.capabilities.subagents.state).toBe("available");
      expect(caps.capabilities.per_agent_model_selection?.state).toBe("available");
    });

    it("detects models and effort values from .windsurf/settings.json", async () => {
      const windsurfDir = path.join(workspaceDir, ".windsurf");
      await fsp.mkdir(windsurfDir, { recursive: true });
      await fsp.writeFile(
        path.join(windsurfDir, "settings.json"),
        JSON.stringify({
          "cascade.model": "claude-3-7-sonnet",
          models: ["claude-3-5-sonnet", "gpt-4o"],
          "cascade.reasoningEffort": "high",
          supported_effort_values: ["low", "medium", "high"],
        }),
        "utf-8"
      );

      const adapter = new WindsurfAdapter();
      const models = await adapter.inspectModels(workspaceDir);
      const modelIds = models.map((m) => m.id);
      expect(modelIds).toContain("claude-3-7-sonnet");
      expect(modelIds).toContain("claude-3-5-sonnet");
      expect(modelIds).toContain("gpt-4o");

      const effortValues = await adapter.inspectEffortValues(workspaceDir);
      expect(effortValues).toEqual(["low", "medium", "high"]);

      const policyHigh = await adapter.resolveReasoningPolicy("highest-supported", undefined, workspaceDir);
      expect(policyHigh).toEqual({
        host_field: "cascade.reasoningEffort",
        host_value: "high",
      });
    });

    it("detects concurrency and activates parallelism only when > 1", async () => {
      process.env.WINDSURF_MAX_CONCURRENCY = "2";
      const adapter = new WindsurfAdapter();
      const caps = await adapter.inspectCapabilities(workspaceDir);

      expect(caps.capabilities.concurrency?.state).toBe("available");
      expect(caps.capabilities.concurrency?.max_concurrency).toBe(2);
      expect(caps.capabilities.parallelism.state).toBe("available");

      const topo = await adapter.inspectExecutionTopologyCapabilities(workspaceDir);
      expect(topo.supports_parallel_execution).toBe(true);
      expect(topo.max_concurrency).toBe(2);
    });
  });

  describe("MCP Companion Registration Lifecycle", () => {
    it("correctly detects unregistered, previews diff, applies atomically, and validates", async () => {
      const adapter = new WindsurfAdapter();
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
      const adapter = new WindsurfAdapter();
      const plan: ExecutionConfig = {
        execution_id: "windsurf-plan-1",
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
