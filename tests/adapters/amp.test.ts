import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { AmpAdapter } from "../../src/adapters/amp/index.js";
import { ExecutionConfig } from "../../src/profile/schema.js";
import { createMockSubprocessRunner, MockSubprocessRunner } from "../harness/mock-runner.js";

describe("Amp Native Adapter Tests (P1)", () => {
  let tempDir: string;
  let workspaceDir: string;
  let userHomeDir: string;
  let originalHome: string | undefined;
  let originalEnv: Record<string, string | undefined>;
  let mockRunner: MockSubprocessRunner;

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "amp-adapter-test-"));
    workspaceDir = path.join(tempDir, "workspace");
    userHomeDir = path.join(tempDir, "home");
    await fsp.mkdir(workspaceDir, { recursive: true });
    await fsp.mkdir(userHomeDir, { recursive: true });

    mockRunner = createMockSubprocessRunner();
    mockRunner.installGlobalHook();

    originalHome = process.env.HOME;
    originalEnv = {
      AMP_CLI: process.env.AMP_CLI,
      AMP_AGENT: process.env.AMP_AGENT,
      AMP_SESSION_ID: process.env.AMP_SESSION_ID,
      AMP_PROJECT_DIR: process.env.AMP_PROJECT_DIR,
      AMP_CONFIG_DIR: process.env.AMP_CONFIG_DIR,
      AMP_VERSION: process.env.AMP_VERSION,
      AMP_CLI_VERSION: process.env.AMP_CLI_VERSION,
      AMP_MODEL: process.env.AMP_MODEL,
      AMP_REASONING_EFFORT: process.env.AMP_REASONING_EFFORT,
      AMP_MAX_CONCURRENCY: process.env.AMP_MAX_CONCURRENCY,
    };

    process.env.HOME = userHomeDir;
    delete process.env.AMP_CLI;
    delete process.env.AMP_AGENT;
    delete process.env.AMP_SESSION_ID;
    delete process.env.AMP_PROJECT_DIR;
    delete process.env.AMP_CONFIG_DIR;
    delete process.env.AMP_VERSION;
    delete process.env.AMP_CLI_VERSION;
    delete process.env.AMP_MODEL;
    delete process.env.AMP_REASONING_EFFORT;
    delete process.env.AMP_MAX_CONCURRENCY;
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
    it("identifies Amp from environment variables", async () => {
      const adapter = new AmpAdapter();
      expect(adapter.hasActiveRuntimeContext(workspaceDir)).toBe(false);

      process.env.AMP_CLI = "1";
      expect(adapter.hasActiveRuntimeContext(workspaceDir)).toBe(true);
      expect(await adapter.identifyHost(workspaceDir)).toBe(true);

      delete process.env.AMP_CLI;
      process.env.AMP_AGENT = "true";
      expect(adapter.hasActiveRuntimeContext(workspaceDir)).toBe(true);
      expect(await adapter.identifyHost(workspaceDir)).toBe(true);
    });

    it("identifies Amp from workspace .amp directory or config files", async () => {
      const adapter = new AmpAdapter();
      expect(await adapter.identifyHost(workspaceDir)).toBe(false);

      const ampDir = path.join(workspaceDir, ".amp");
      await fsp.mkdir(ampDir, { recursive: true });
      expect(await adapter.identifyHost(workspaceDir)).toBe(true);

      await fsp.rm(ampDir, { recursive: true, force: true });
      expect(await adapter.identifyHost(workspaceDir)).toBe(false);

      await fsp.writeFile(path.join(workspaceDir, "amp.json"), "{}", "utf-8");
      expect(await adapter.identifyHost(workspaceDir)).toBe(true);
    });

    it("identifies Amp from user home configs when workspaceRoot is omitted", async () => {
      const adapter = new AmpAdapter();
      expect(await adapter.identifyHost()).toBe(false);

      const userAmpDir = path.join(userHomeDir, ".amp");
      await fsp.mkdir(userAmpDir, { recursive: true });
      expect(await adapter.identifyHost()).toBe(true);
    });
  });

  describe("Version Detection & Fail-Closed Semantics", () => {
    it("returns unknown-version with fail_closed_for_mutation: true when unevidenced", async () => {
      const adapter = new AmpAdapter();
      const version = await adapter.inspectVersion(workspaceDir);
      expect(version.compatibility).toBe("unknown-version");
      expect(version.fail_closed_for_mutation).toBe(true);
    });

    it("detects version from workspace .amp/version", async () => {
      const ampDir = path.join(workspaceDir, ".amp");
      await fsp.mkdir(ampDir, { recursive: true });
      await fsp.writeFile(path.join(ampDir, "version"), "1.2.3\n", "utf-8");

      const adapter = new AmpAdapter();
      const version = await adapter.inspectVersion(workspaceDir);
      expect(version.version).toBe("1.2.3");
      expect(version.compatibility).toBe("supported");
      expect(version.fail_closed_for_mutation).toBe(false);
    });

    it("detects version from CLI execution via mockRunner", async () => {
      mockRunner.register("amp", {
        exitCode: 0,
        stdout: "amp 1.5.0 (build 99)\n",
      });

      const adapter = new AmpAdapter();
      const version = await adapter.inspectVersion(workspaceDir);
      expect(version.version).toBe("1.5.0");
      expect(version.compatibility).toBe("supported");
      expect(version.fail_closed_for_mutation).toBe(false);
    });

    it("marks explicit incompatible version as incompatible and fails closed", async () => {
      process.env.AMP_VERSION = "incompatible";
      const adapter = new AmpAdapter();
      const version = await adapter.inspectVersion(workspaceDir);
      expect(version.compatibility).toBe("incompatible");
      expect(version.fail_closed_for_mutation).toBe(true);
    });
  });

  describe("Capabilities & Anti-Guessing Invariants", () => {
    it("reports unknown for unconfirmed capabilities without inventing models or effort", async () => {
      const adapter = new AmpAdapter();
      const caps = await adapter.inspectCapabilities(workspaceDir);

      expect(caps.host_id).toBe("amp");
      expect(caps.adapter_id).toBe("amp");
      expect(caps.available_models).toEqual([]);
      expect(caps.supported_effort_values).toEqual([]);
      expect(caps.capabilities.subagents.state).toBe("unknown");
      expect(caps.capabilities.threads.state).toBe("unknown");
      expect(caps.capabilities.parallelism.state).toBe("unknown");
      expect(caps.capabilities.concurrency?.state).toBe("unknown");
      expect(caps.capabilities.reasoning?.state).toBe("unknown");
    });

    it("detects subagents when .amp/agents directory exists", async () => {
      const agentsDir = path.join(workspaceDir, ".amp", "agents");
      await fsp.mkdir(agentsDir, { recursive: true });

      const adapter = new AmpAdapter();
      const caps = await adapter.inspectCapabilities(workspaceDir);
      expect(caps.capabilities.subagents.state).toBe("available");
      expect(caps.capabilities.per_agent_model_selection?.state).toBe("available");
    });

    it("detects models and effort values from .amp/settings.json", async () => {
      const ampDir = path.join(workspaceDir, ".amp");
      await fsp.mkdir(ampDir, { recursive: true });
      await fsp.writeFile(
        path.join(ampDir, "settings.json"),
        JSON.stringify({
          model: "claude-3-7-sonnet",
          models: ["claude-3-5-sonnet", "gpt-4o"],
          supported_effort_values: ["low", "medium", "high"],
        }),
        "utf-8"
      );

      const adapter = new AmpAdapter();
      const models = await adapter.inspectModels(workspaceDir);
      const modelIds = models.map((m) => m.id);
      expect(modelIds).toContain("claude-3-7-sonnet");
      expect(modelIds).toContain("claude-3-5-sonnet");
      expect(modelIds).toContain("gpt-4o");

      const effortValues = await adapter.inspectEffortValues(workspaceDir);
      expect(effortValues).toEqual(["low", "medium", "high"]);

      const policyHigh = await adapter.resolveReasoningPolicy("highest-supported", undefined, workspaceDir);
      expect(policyHigh).toEqual({
        host_field: "reasoning_effort",
        host_value: "high",
      });

      const policyLow = await adapter.resolveReasoningPolicy("lowest-sufficient", undefined, workspaceDir);
      expect(policyLow).toEqual({
        host_field: "reasoning_effort",
        host_value: "low",
      });
    });

    it("detects concurrency and activates parallelism only when > 1", async () => {
      process.env.AMP_MAX_CONCURRENCY = "4";
      const adapter = new AmpAdapter();
      const caps = await adapter.inspectCapabilities(workspaceDir);

      expect(caps.capabilities.concurrency?.state).toBe("available");
      expect(caps.capabilities.concurrency?.max_concurrency).toBe(4);
      expect(caps.capabilities.parallelism.state).toBe("available");

      const topo = await adapter.inspectExecutionTopologyCapabilities(workspaceDir);
      expect(topo.supports_parallel_execution).toBe(true);
      expect(topo.max_concurrency).toBe(4);
    });
  });

  describe("MCP Companion Registration Lifecycle", () => {
    it("correctly detects unregistered, previews diff, applies atomically, and validates", async () => {
      const adapter = new AmpAdapter();
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
      const adapter = new AmpAdapter();
      const plan: ExecutionConfig = {
        execution_id: "amp-plan-1",
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
