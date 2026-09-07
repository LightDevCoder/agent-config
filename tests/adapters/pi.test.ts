import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import childProcess from "node:child_process";
import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { PiAdapter } from "../../src/adapters/pi/index.js";
import { ExecutionConfig } from "../../src/profile/schema.js";

describe("Pi Native Adapter Tests", () => {
  let tempDir: string;
  let workspaceDir: string;
  let userHomeDir: string;
  let piAgentDir: string;
  let originalEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-adapter-test-"));
    workspaceDir = path.join(tempDir, "workspace");
    userHomeDir = path.join(tempDir, "home");
    piAgentDir = path.join(userHomeDir, ".pi", "agent");
    await fsp.mkdir(workspaceDir, { recursive: true });
    await fsp.mkdir(piAgentDir, { recursive: true });

    originalEnv = {
      HOME: process.env.HOME,
      PI_CODING_AGENT: process.env.PI_CODING_AGENT,
      AI_AGENT: process.env.AI_AGENT,
      PI_SESSION_FILE: process.env.PI_SESSION_FILE,
      PI_SESSION_ID: process.env.PI_SESSION_ID,
      PI_MODEL: process.env.PI_MODEL,
      PI_PROVIDER: process.env.PI_PROVIDER,
      PI_REASONING_LEVEL: process.env.PI_REASONING_LEVEL,
      PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
      PI_VERSION: process.env.PI_VERSION,
    };

    process.env.HOME = userHomeDir;
    process.env.PI_CODING_AGENT_DIR = piAgentDir;
    delete process.env.PI_CODING_AGENT;
    delete process.env.AI_AGENT;
    delete process.env.PI_SESSION_FILE;
    delete process.env.PI_SESSION_ID;
    delete process.env.PI_MODEL;
    delete process.env.PI_PROVIDER;
    delete process.env.PI_REASONING_LEVEL;
    delete process.env.PI_VERSION;
    vi.spyOn(childProcess, "spawnSync").mockReturnValue({ status: 0, stdout: "0.85.1", stderr: "" } as any);
    await fsp.writeFile(path.join(piAgentDir, "settings.json"), JSON.stringify({
      defaultProjectTrust: "always", packages: ["npm:pi-mcp-adapter"], defaultProvider: "test-provider",
      defaultModel: "gemini-3.8-flash-high", defaultThinkingLevel: "high",
    }));
    const extension = path.join(piAgentDir, "npm", "node_modules", "pi-mcp-adapter");
    await fsp.mkdir(extension, { recursive: true });
    await fsp.writeFile(path.join(extension, "package.json"), JSON.stringify({ name: "pi-mcp-adapter" }));
    await fsp.writeFile(path.join(piAgentDir, "models.json"), JSON.stringify({ providers: {
      "test-provider": { models: [{ id: "gemini-3.8-flash-high", reasoning: true,
        thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null } }] },
    } }));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v === undefined) delete (process.env as any)[k];
      else (process.env as any)[k] = v;
    }

    if (fs.existsSync(tempDir)) {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  describe("Identification & Runtime Context", () => {
    it("identifies host via active environment variables", async () => {
      const adapter = new PiAdapter();
      expect(adapter.hasActiveRuntimeContext()).toBe(false);

      process.env.PI_CODING_AGENT = "true";
      expect(adapter.hasActiveRuntimeContext()).toBe(true);
      expect(await adapter.identifyHost(workspaceDir)).toBe(true);

      delete process.env.PI_CODING_AGENT;
      process.env.AI_AGENT = "pi";
      expect(adapter.hasActiveRuntimeContext()).toBe(true);
      expect(await adapter.identifyHost(workspaceDir)).toBe(true);
    });

    it("identifies host via workspace directory marker .pi", async () => {
      const adapter = new PiAdapter();
      expect(await adapter.identifyHost(workspaceDir)).toBe(false);

      await fsp.mkdir(path.join(workspaceDir, ".pi"), { recursive: true });
      expect(await adapter.identifyHost(workspaceDir)).toBe(true);
    });

    it("identifies host via global ~/.pi/agent/settings.json when no workspace provided", async () => {
      const adapter = new PiAdapter();
      await fsp.writeFile(
        path.join(piAgentDir, "settings.json"),
        JSON.stringify({ defaultModel: "gemini-3.8-flash-high" }),
        "utf-8"
      );
      expect(await adapter.identifyHost()).toBe(true);
    });
  });

  describe("Version evidence", () => {
    it("uses the actual CLI version, ignoring synthetic env and changelog settings", async () => {
      process.env.PI_VERSION = "9.0.0";
      expect((await new PiAdapter().inspectVersion(workspaceDir)).version).toBe("0.85.1");
    });
    it.each(["0.86.0-beta.1", "1.0.0", "not-a-version"])("rejects mutation for %s", async (version) => {
      vi.mocked(childProcess.spawnSync).mockReturnValue({ status: 0, stdout: version } as any);
      const adapter = new PiAdapter();
      expect((await adapter.inspectVersion(workspaceDir)).fail_closed_for_mutation).toBe(true);
      expect((await adapter.previewCompanionRegistration(workspaceDir)).supported).toBe(false);
      await expect(adapter.renderConfiguration({ execution: { model: "gemini-3.8-flash-high" } } as ExecutionConfig,
        undefined, workspaceDir)).rejects.toThrow(/version/);
    });
  });

  describe("Models & Capabilities Inspection", () => {
    it("enumerates models from cliproxyapi-models.json and active env", async () => {
      await fsp.writeFile(
        path.join(piAgentDir, "cliproxyapi-models.json"),
        JSON.stringify({
          models: [
            { id: "gpt-6-astra", name: "GPT 6.0 Astra", reasoning: true },
            { id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash High", reasoning: true },
          ],
        }),
        "utf-8"
      );

      process.env.PI_MODEL = "gemini-3.8-flash-high";

      const adapter = new PiAdapter();
      const models = await adapter.inspectModels(workspaceDir);

      expect(models.length).toBe(2);
      expect(models.map((m) => m.id)).toContain("test-provider/gemini-3.8-flash-high");
      expect(models.map((m) => m.id)).not.toContain("gpt-6-astra");
      expect(models.map((m) => m.id)).toContain("gemini-3.8-flash-high");

      const gemini = models.find((m) => m.id === "gemini-3.8-flash-high");
      expect(gemini?.features).toContain("tools");
    });

    it("inspects reasoning options when configured or active", async () => {
      process.env.PI_REASONING_LEVEL = "high";
      const adapter = new PiAdapter();
      const opts = await adapter.inspectReasoningOptions(workspaceDir);

      expect(opts.native_field).toBe("defaultThinkingLevel");
      expect(opts.supported_values).toContain("high");
      expect(opts.supported_values).toContain("medium");
      expect(opts.default_value).toBe("high");
    });

    it("reports honest single-session execution topology", async () => {
      const adapter = new PiAdapter();
      const topo = await adapter.inspectExecutionTopologyCapabilities(workspaceDir);

      expect(topo.supports_single_session).toBe(true);
      expect(topo.supports_subagents).toBe(false);
      expect(topo.supports_parallel_execution).toBe(false);
      expect(topo.max_concurrency).toBeUndefined();
      expect((await adapter.inspectCapabilities(workspaceDir)).capabilities.subagents.state).toBe("unknown");
    });
  });

  describe("Companion MCP Registration Lifecycle", () => {
    it("reports unregistered initially", async () => {
      const adapter = new PiAdapter();
      const status = await adapter.inspectCompanionRegistration(workspaceDir, "project");

      expect(status.registered).toBe(false);
      expect(status.target_file).toBe(path.join(workspaceDir, ".pi", "mcp.json"));
    });

    it("previews, applies, and validates companion registration for project scope", async () => {
      const adapter = new PiAdapter();
      const preview = await adapter.previewCompanionRegistration(workspaceDir, "project");

      expect(preview.supported).toBe(true);
      expect(preview.mutation_targets).toContain(path.join(workspaceDir, ".pi", "mcp.json"));
      expect(preview.diff).toContain("agent-config");

      const applyRes = await adapter.applyCompanionRegistration(preview.preview_hash!, workspaceDir, preview);
      expect(applyRes.success).toBe(true);

      const status = await adapter.inspectCompanionRegistration(workspaceDir, "project");
      expect(status.registered).toBe(true);
      expect(status.command).toBe("agent-config");

      const validation = await adapter.validateCompanionRegistration(workspaceDir);
      expect(validation.valid).toBe(true);
    });

    it("previews, applies, and validates companion registration for global scope", async () => {
      const adapter = new PiAdapter();
      const preview = await adapter.previewCompanionRegistration(workspaceDir, "global");

      expect(preview.supported).toBe(true);
      expect(preview.mutation_targets).toContain(path.join(piAgentDir, "mcp.json"));

      const applyRes = await adapter.applyCompanionRegistration(preview.preview_hash!, workspaceDir, preview);
      expect(applyRes.success).toBe(true);

      const status = await adapter.inspectCompanionRegistration(workspaceDir, "global");
      expect(status.registered).toBe(true);
      expect(status.scope).toBe("global");
    });
  });

  describe("Configuration Preview & Mutation", () => {
    it("previews and applies execution configuration changes cleanly", async () => {
      const adapter = new PiAdapter();
      const plan: ExecutionConfig = {
        execution_id: "plan-pi-001",
        controller: { model: "gemini-3.8-flash-high" },
        execution: { model: "gemini-3.8-flash-high", effort: "high" },
      };

      const preview = await adapter.previewConfiguration(plan, undefined, workspaceDir);
      expect(preview.mutation_targets).toBeDefined();

      const applyRes = await adapter.applyConfiguration(preview.preview_id, preview, workspaceDir);
      expect(applyRes.success).toBe(true);

      const validation = await adapter.validateConfiguration(plan, workspaceDir);
      expect(validation.valid).toBe(true);
    });

    it("resolves abstract reasoning policies correctly", async () => {
      process.env.PI_REASONING_LEVEL = "medium";
      const adapter = new PiAdapter();

      const highest = await adapter.resolveReasoningPolicy("highest-supported", undefined, workspaceDir);
      expect(highest?.host_value).toBe("high");

      const lowest = await adapter.resolveReasoningPolicy("lowest-supported", undefined, workspaceDir);
      expect(lowest?.host_value).toBe("low");

      const configured = await adapter.resolveReasoningPolicy("configured", undefined, workspaceDir);
      expect(configured?.host_value).toBe("medium");
    });
  });
  describe("Pi review regressions", () => {
    it("does not register MCP without its enabled extension", async () => {
      await fsp.writeFile(path.join(piAgentDir, "settings.json"), "{}");
      const adapter = new PiAdapter();
      expect((await adapter.previewCompanionRegistration(workspaceDir)).supported).toBe(false);
      expect((await adapter.inspectCompanionRegistration(workspaceDir)).registered).toBe(false);
    });
    it("keeps project writes local when global settings exist and detects missing effort", async () => {
      const adapter = new PiAdapter();
      const globalBefore = await fsp.readFile(path.join(piAgentDir, "settings.json"), "utf-8");
      const plan = { execution: { model: "gemini-3.8-flash-high", effort: "high" } } as ExecutionConfig;
      const preview = await adapter.renderConfiguration(plan, undefined, workspaceDir);
      expect(preview.mutation_targets).toEqual([path.join(workspaceDir, ".pi", "settings.json")]);
      await adapter.applyConfiguration(preview.preview_id, preview, workspaceDir);
      expect(await fsp.readFile(path.join(piAgentDir, "settings.json"), "utf-8")).toBe(globalBefore);
      const actual = JSON.parse(preview.files![0].content);
      expect(actual.defaultProvider).toBe("test-provider");
      delete actual.defaultThinkingLevel;
      await fsp.writeFile(preview.mutation_targets[0], JSON.stringify(actual));
      expect((await adapter.validateConfiguration(plan, workspaceDir)).valid).toBe(false);
    });
    it("rejects unevidenced model/provider and unsupported max", async () => {
      const adapter = new PiAdapter();
      await expect(adapter.renderConfiguration({ execution: { model: "unknown" } } as ExecutionConfig,
        undefined, workspaceDir)).rejects.toThrow(/provider\/model/);
      await expect(adapter.renderConfiguration({ execution: { model: "gemini-3.8-flash-high", effort: "max" } } as ExecutionConfig,
        undefined, workspaceDir)).rejects.toThrow(/Unevidenced/);
    });
    it("rejects provider drift for an unchanged bare model ID", async () => {
      const adapter = new PiAdapter();
      const plan = { execution: { model: "gemini-3.8-flash-high", effort: "high" } } as ExecutionConfig;
      const preview = await adapter.renderConfiguration(plan, undefined, workspaceDir);
      await adapter.applyConfiguration(preview.preview_id, preview, workspaceDir);
      const actual = JSON.parse(preview.files![0].content);
      actual.defaultProvider = "wrong-provider";
      await fsp.writeFile(preview.mutation_targets[0], JSON.stringify(actual));
      expect((await adapter.validateConfiguration(plan, workspaceDir)).valid).toBe(false);
    });

    it("updates an inherited per-model thinking override and detects later drift", async () => {
      const settingsPath = path.join(piAgentDir, "settings.json");
      const settings = JSON.parse(await fsp.readFile(settingsPath, "utf-8"));
      const key = "test-provider/gemini-3.8-flash-high";
      settings.modelThinkingLevels = { [key]: "low", "other/model": "medium" };
      await fsp.writeFile(settingsPath, JSON.stringify(settings));
      await fsp.mkdir(path.join(workspaceDir, ".pi"), { recursive: true });
      await fsp.writeFile(path.join(workspaceDir, ".pi", "settings.json"), JSON.stringify({
        modelThinkingLevels: { "unrelated/model": "low" },
      }));
      const adapter = new PiAdapter();
      const plan = { execution: { model: "gemini-3.8-flash-high", effort: "high" } } as ExecutionConfig;
      const preview = await adapter.renderConfiguration(plan, undefined, workspaceDir);
      await adapter.applyConfiguration(preview.preview_id, preview, workspaceDir);
      const actual = JSON.parse(preview.files![0].content);
      expect(actual.modelThinkingLevels[key]).toBe("high");
      expect(JSON.parse(await fsp.readFile(settingsPath, "utf-8"))).toEqual(settings);
      expect((await adapter.validateConfiguration(plan, workspaceDir)).valid).toBe(true);
      actual.modelThinkingLevels[key] = "low";
      await fsp.writeFile(preview.mutation_targets[0], JSON.stringify(actual));
      expect((await adapter.validateConfiguration(plan, workspaceDir)).valid).toBe(false);
    });

    it("does not validate project settings that Pi has not trusted", async () => {
      const adapter = new PiAdapter();
      const plan = { execution: { model: "gemini-3.8-flash-high" } } as ExecutionConfig;
      const preview = await adapter.renderConfiguration(plan, undefined, workspaceDir);
      await adapter.applyConfiguration(preview.preview_id, preview, workspaceDir);
      const settingsPath = path.join(piAgentDir, "settings.json");
      const settings = JSON.parse(await fsp.readFile(settingsPath, "utf-8"));
      delete settings.defaultProjectTrust;
      await fsp.writeFile(settingsPath, JSON.stringify(settings));
      expect((await adapter.validateConfiguration(plan, workspaceDir)).valid).toBe(false);
      await fsp.writeFile(path.join(piAgentDir, "trust.json"), JSON.stringify({ [fs.realpathSync(workspaceDir)]: true }));
      expect((await adapter.validateConfiguration(plan, workspaceDir)).valid).toBe(true);
    });

    it("rechecks version before applying an already rendered preview", async () => {
      const adapter = new PiAdapter();
      const preview = await adapter.renderConfiguration({ execution: { model: "gemini-3.8-flash-high" } } as ExecutionConfig, undefined, workspaceDir);
      vi.mocked(childProcess.spawnSync).mockReturnValue({ status: 1, stdout: "" } as any);
      expect((await adapter.applyConfiguration(preview.preview_id, preview, workspaceDir)).success).toBe(false);
      expect(fs.existsSync(preview.mutation_targets[0])).toBe(false);
    });
  });

});
