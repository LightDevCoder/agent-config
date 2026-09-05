import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { KiroAdapter } from "../../src/adapters/kiro/index.js";
import { ExecutionConfig } from "../../src/profile/schema.js";

describe("Kiro Native Adapter Tests (§37)", () => {
  let tempDir: string;
  let workspaceDir: string;
  let userHomeDir: string;
  let originalHome: string | undefined;
  let originalEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "kiro-adapter-test-"));
    workspaceDir = path.join(tempDir, "workspace");
    userHomeDir = path.join(tempDir, "home");
    await fsp.mkdir(workspaceDir, { recursive: true });
    await fsp.mkdir(userHomeDir, { recursive: true });

    originalHome = process.env.HOME;
    originalEnv = {
      KIRO_IDE: process.env.KIRO_IDE,
      KIRO_CLI: process.env.KIRO_CLI,
      KIRO_SESSION: process.env.KIRO_SESSION,
      KIRO_SESSION_ID: process.env.KIRO_SESSION_ID,
      KIRO_AGENT: process.env.KIRO_AGENT,
      KIRO_HOME: process.env.KIRO_HOME,
      KIRO_CONFIG_DIR: process.env.KIRO_CONFIG_DIR,
      KIRO_VERSION: process.env.KIRO_VERSION,
      KIRO_MODEL: process.env.KIRO_MODEL,
      KIRO_MAX_CONCURRENCY: process.env.KIRO_MAX_CONCURRENCY,
      KIRO_REASONING_EFFORT: process.env.KIRO_REASONING_EFFORT,
    };

    process.env.HOME = userHomeDir;
    delete process.env.KIRO_IDE;
    delete process.env.KIRO_CLI;
    delete process.env.KIRO_SESSION;
    delete process.env.KIRO_SESSION_ID;
    delete process.env.KIRO_AGENT;
    delete process.env.KIRO_HOME;
    delete process.env.KIRO_CONFIG_DIR;
    delete process.env.KIRO_VERSION;
    delete process.env.KIRO_MODEL;
    delete process.env.KIRO_MAX_CONCURRENCY;
    delete process.env.KIRO_REASONING_EFFORT;
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
    it("identifies Kiro from environment variables", async () => {
      const adapter = new KiroAdapter();
      expect(adapter.hasActiveRuntimeContext(workspaceDir)).toBe(false);

      process.env.KIRO_CLI = "1";
      expect(adapter.hasActiveRuntimeContext(workspaceDir)).toBe(true);
      expect(await adapter.identifyHost(workspaceDir)).toBe(true);

      delete process.env.KIRO_CLI;
      process.env.KIRO_IDE = "1";
      expect(adapter.hasActiveRuntimeContext(workspaceDir)).toBe(true);
      expect(await adapter.identifyHost(workspaceDir)).toBe(true);
    });

    it("identifies Kiro from workspace .kiro directory", async () => {
      const adapter = new KiroAdapter();
      expect(await adapter.identifyHost(workspaceDir)).toBe(false);

      await fsp.mkdir(path.join(workspaceDir, ".kiro"), { recursive: true });
      expect(await adapter.identifyHost(workspaceDir)).toBe(true);
    });

    it("identifies Kiro from workspace kiro.json file", async () => {
      const adapter = new KiroAdapter();
      await fsp.writeFile(path.join(workspaceDir, "kiro.json"), "{}", "utf-8");
      expect(await adapter.identifyHost(workspaceDir)).toBe(true);
    });

    it("identifies Kiro from user directory when no workspace supplied", async () => {
      const adapter = new KiroAdapter();
      await fsp.mkdir(path.join(userHomeDir, ".kiro"), { recursive: true });
      expect(await adapter.identifyHost()).toBe(true);
    });
  });

  describe("Unified Surface & Capability Distinction", () => {
    it("distinguishes IDE surface mode from environment or marker", () => {
      const adapter = new KiroAdapter();
      expect(adapter.getSurfaceMode(workspaceDir)).toBe("unified");

      process.env.KIRO_IDE = "true";
      expect(adapter.getSurfaceMode(workspaceDir)).toBe("ide");

      delete process.env.KIRO_IDE;
      process.env.KIRO_CLI = "1";
      expect(adapter.getSurfaceMode(workspaceDir)).toBe("cli");
    });

    it("distinguishes surface mode from filesystem markers", async () => {
      const adapter = new KiroAdapter();
      const kiroDir = path.join(workspaceDir, ".kiro");
      await fsp.mkdir(kiroDir, { recursive: true });
      await fsp.writeFile(path.join(kiroDir, "ide"), "", "utf-8");

      expect(adapter.getSurfaceMode(workspaceDir)).toBe("ide");
    });
  });

  describe("Version Inspection & Compatibility", () => {
    it("reports unknown-version and fails closed when unevidenced", async () => {
      const adapter = new KiroAdapter();
      const version = await adapter.inspectVersion(workspaceDir);
      expect(version.compatibility).toBe("unknown-version");
      expect(version.fail_closed_for_mutation).toBe(true);
    });

    it("detects supported version from KIRO_VERSION env", async () => {
      process.env.KIRO_VERSION = "1.0.4";
      const adapter = new KiroAdapter();
      const version = await adapter.inspectVersion(workspaceDir);
      expect(version.compatibility).toBe("supported");
      expect(version.fail_closed_for_mutation).toBe(false);
      expect(version.version).toBe("1.0.4");
    });

    it("detects version from .kiro/version file", async () => {
      const kiroDir = path.join(workspaceDir, ".kiro");
      await fsp.mkdir(kiroDir, { recursive: true });
      await fsp.writeFile(path.join(kiroDir, "version"), "0.9.1\n", "utf-8");

      const adapter = new KiroAdapter();
      const version = await adapter.inspectVersion(workspaceDir);
      expect(version.compatibility).toBe("supported");
      expect(version.version).toBe("0.9.1");
    });

    it("detects partially-supported version 2.x", async () => {
      process.env.KIRO_VERSION = "2.1.0";
      const adapter = new KiroAdapter();
      const version = await adapter.inspectVersion(workspaceDir);
      expect(version.compatibility).toBe("partially-supported");
      expect(version.fail_closed_for_mutation).toBe(false);
    });

    it("detects incompatible version", async () => {
      process.env.KIRO_VERSION = "incompatible";
      const adapter = new KiroAdapter();
      const version = await adapter.inspectVersion(workspaceDir);
      expect(version.compatibility).toBe("incompatible");
      expect(version.fail_closed_for_mutation).toBe(true);
    });
  });

  describe("MCP Scoping: Workspace, User, and Agent Scopes (§37)", () => {
    it("detects companion registration in workspace config.json", async () => {
      const kiroDir = path.join(workspaceDir, ".kiro");
      await fsp.mkdir(kiroDir, { recursive: true });
      await fsp.writeFile(
        path.join(kiroDir, "config.json"),
        JSON.stringify({
          mcpServers: {
            "agent-config": { command: "agent-config", args: ["serve"] },
          },
        }),
        "utf-8"
      );

      const adapter = new KiroAdapter();
      const status = await adapter.inspectCompanionRegistration(workspaceDir);
      expect(status.registered).toBe(true);
      expect((status.details as any).scope).toBe("workspace");
    });

    it("detects companion registration in agent-level MCP configuration", async () => {
      const agentsDir = path.join(workspaceDir, ".kiro", "agents");
      await fsp.mkdir(agentsDir, { recursive: true });
      await fsp.writeFile(
        path.join(agentsDir, "worker.json"),
        JSON.stringify({
          name: "worker",
          mcpServers: {
            "agent-config": { command: "agent-config", args: ["serve"] },
          },
        }),
        "utf-8"
      );

      const adapter = new KiroAdapter();
      const status = await adapter.inspectCompanionRegistration(workspaceDir);
      expect(status.registered).toBe(true);
      expect((status.details as any).scope).toBe("agent");
    });

    it("runs complete companion registration preview, apply, and validate lifecycle", async () => {
      const adapter = new KiroAdapter();

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

  describe("Models & Subagents Inspection", () => {
    it("inspects models and subagents from .kiro/config.json", async () => {
      const kiroDir = path.join(workspaceDir, ".kiro");
      await fsp.mkdir(kiroDir, { recursive: true });
      await fsp.writeFile(
        path.join(kiroDir, "config.json"),
        JSON.stringify({
          model: "claude-3-7-sonnet",
          supported_models: ["claude-3-7-sonnet", "claude-3-5-haiku"],
          agents: {
            worker: { model: "claude-3-5-haiku" },
          },
        }),
        "utf-8"
      );

      const adapter = new KiroAdapter();
      const models = await adapter.inspectModels(workspaceDir);
      expect(models.map((m) => m.id)).toContain("claude-3-7-sonnet");
      expect(models.map((m) => m.id)).toContain("claude-3-5-haiku");

      const caps = await adapter.inspectCapabilities(workspaceDir);
      expect(caps.capabilities.subagents.state).toBe("available");
      expect(caps.capabilities.per_agent_model_selection?.state).toBe("available");
    });

    it("reports subagents as unknown when unevidenced", async () => {
      const adapter = new KiroAdapter();
      const caps = await adapter.inspectCapabilities(workspaceDir);
      expect(caps.capabilities.subagents.state).toBe("unknown");
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
          ticket_id: "task-infra",
          difficulty: "routine",
          model: "claude-3-5-haiku",
        },
      ],
    };

    it("renders and applies single-pass configuration to .kiro/config.json", async () => {
      const adapter = new KiroAdapter();
      const rendered = await adapter.renderConfiguration(singlePlan, undefined, workspaceDir);

      expect(rendered.mutation_targets[0]).toBe(
        path.join(workspaceDir, ".kiro", "config.json")
      );
      expect(rendered.diff).toContain('"model": "claude-3-7-sonnet"');
      expect(rendered.diff).toContain('"reasoning_effort": "high"');

      const apply = await adapter.applyConfiguration(rendered.preview_id, rendered, workspaceDir);
      expect(apply.success).toBe(true);

      const validation = await adapter.validateConfiguration(singlePlan, workspaceDir);
      expect(validation.valid).toBe(true);
    });

    it("renders and applies decomposed plan updating agents in .kiro/config.json", async () => {
      const adapter = new KiroAdapter();
      const rendered = await adapter.renderConfiguration(decomposedPlan, undefined, workspaceDir);

      const apply = await adapter.applyConfiguration(rendered.preview_id, rendered, workspaceDir);
      expect(apply.success).toBe(true);

      const content = await fsp.readFile(
        path.join(workspaceDir, ".kiro", "config.json"),
        "utf-8"
      );
      const parsed = JSON.parse(content);
      expect(parsed.agents?.["task-infra"]?.model).toBe("claude-3-5-haiku");

      const validation = await adapter.validateConfiguration(decomposedPlan, workspaceDir);
      expect(validation.valid).toBe(true);

      // Detect drift
      parsed.agents["task-infra"].model = "unexpected-model";
      await fsp.writeFile(
        path.join(workspaceDir, ".kiro", "config.json"),
        JSON.stringify(parsed),
        "utf-8"
      );
      const driftValidation = await adapter.validateConfiguration(decomposedPlan, workspaceDir);
      expect(driftValidation.valid).toBe(false);
    });

    it("fails closed on malformed existing configuration", async () => {
      const kiroDir = path.join(workspaceDir, ".kiro");
      await fsp.mkdir(kiroDir, { recursive: true });
      await fsp.writeFile(
        path.join(kiroDir, "config.json"),
        "{ broken json content",
        "utf-8"
      );

      const adapter = new KiroAdapter();
      await expect(
        adapter.renderConfiguration(singlePlan, undefined, workspaceDir)
      ).rejects.toThrow(/syntax error/i);
    });
  });
});
