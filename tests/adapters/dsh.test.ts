import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DshAdapter } from "../../src/adapters/dsh/index.js";
import { ExecutionConfig } from "../../src/profile/schema.js";

describe("DeepSeek Harness (DSH) Native Adapter Tests (§39, §40, §41, §42, §43)", () => {
  let tempDir: string;
  let workspaceDir: string;
  let userHomeDir: string;
  let originalHome: string | undefined;
  let originalEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "dsh-adapter-test-"));
    workspaceDir = path.join(tempDir, "workspace");
    userHomeDir = path.join(tempDir, "home");
    await fsp.mkdir(workspaceDir, { recursive: true });
    await fsp.mkdir(userHomeDir, { recursive: true });

    originalHome = process.env.HOME;
    originalEnv = {
      DSH_RUNTIME: process.env.DSH_RUNTIME,
      DEEPSEEK_HARNESS: process.env.DEEPSEEK_HARNESS,
      CORDIS_APP: process.env.CORDIS_APP,
      DSH_PLUGINS: process.env.DSH_PLUGINS,
      DSH_SERVICES: process.env.DSH_SERVICES,
      DSH_MOUNTED_SERVICES: process.env.DSH_MOUNTED_SERVICES,
      DSH_SUBAGENT_PROVIDERS: process.env.DSH_SUBAGENT_PROVIDERS,
      DSH_SESSION_ID: process.env.DSH_SESSION_ID,
      DSH_AGENT: process.env.DSH_AGENT,
      DSH_HOME: process.env.DSH_HOME,
      DSH_CONFIG: process.env.DSH_CONFIG,
      DSH_VERSION: process.env.DSH_VERSION,
      DSH_PLUGIN_API_VERSION: process.env.DSH_PLUGIN_API_VERSION,
      DSH_MODEL: process.env.DSH_MODEL,
      DSH_MODELS: process.env.DSH_MODELS,
      DSH_MAX_CONCURRENCY: process.env.DSH_MAX_CONCURRENCY,
      DSH_REASONING_EFFORT: process.env.DSH_REASONING_EFFORT,
      DSH_PRESET: process.env.DSH_PRESET,
      DSH_MODE: process.env.DSH_MODE,
    };

    process.env.HOME = userHomeDir;
    delete process.env.DSH_RUNTIME;
    delete process.env.DEEPSEEK_HARNESS;
    delete process.env.CORDIS_APP;
    delete process.env.DSH_PLUGINS;
    delete process.env.DSH_SERVICES;
    delete process.env.DSH_MOUNTED_SERVICES;
    delete process.env.DSH_SUBAGENT_PROVIDERS;
    delete process.env.DSH_SESSION_ID;
    delete process.env.DSH_AGENT;
    delete process.env.DSH_HOME;
    delete process.env.DSH_CONFIG;
    delete process.env.DSH_VERSION;
    delete process.env.DSH_PLUGIN_API_VERSION;
    delete process.env.DSH_MODEL;
    delete process.env.DSH_MODELS;
    delete process.env.DSH_MAX_CONCURRENCY;
    delete process.env.DSH_REASONING_EFFORT;
    delete process.env.DSH_PRESET;
    delete process.env.DSH_MODE;
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

  describe("Host Identification & Runtime Context (§39)", () => {
    it("identifies DSH from environment markers", async () => {
      const adapter = new DshAdapter();
      expect(adapter.hasActiveRuntimeContext(workspaceDir)).toBe(false);

      process.env.DSH_RUNTIME = "1";
      expect(adapter.hasActiveRuntimeContext(workspaceDir)).toBe(true);
      expect(await adapter.identifyHost(workspaceDir)).toBe(true);

      delete process.env.DSH_RUNTIME;
      process.env.DEEPSEEK_HARNESS = "true";
      expect(adapter.hasActiveRuntimeContext(workspaceDir)).toBe(true);
      expect(await adapter.identifyHost(workspaceDir)).toBe(true);

      delete process.env.DEEPSEEK_HARNESS;
      process.env.CORDIS_APP = "dsh-core";
      expect(adapter.hasActiveRuntimeContext(workspaceDir)).toBe(true);
      expect(await adapter.identifyHost(workspaceDir)).toBe(true);
    });

    it("identifies DSH from workspace markers (.dsh, dsh.config.json, dsh.yml, cordis.yml)", async () => {
      const adapter = new DshAdapter();
      expect(await adapter.identifyHost(workspaceDir)).toBe(false);

      const dshDir = path.join(workspaceDir, ".dsh");
      await fsp.mkdir(dshDir, { recursive: true });
      expect(await adapter.identifyHost(workspaceDir)).toBe(true);
      await fsp.rm(dshDir, { recursive: true });

      const dshConfig = path.join(workspaceDir, "dsh.config.json");
      await fsp.writeFile(dshConfig, "{}", "utf-8");
      expect(await adapter.identifyHost(workspaceDir)).toBe(true);
      await fsp.rm(dshConfig);

      const dshYml = path.join(workspaceDir, "dsh.yml");
      await fsp.writeFile(dshYml, "", "utf-8");
      expect(await adapter.identifyHost(workspaceDir)).toBe(true);
      await fsp.rm(dshYml);

      const cordisYml = path.join(workspaceDir, "cordis.yml");
      await fsp.writeFile(cordisYml, "", "utf-8");
      expect(await adapter.identifyHost(workspaceDir)).toBe(true);
    });

    it("identifies DSH from user home directory when no workspace supplied", async () => {
      const adapter = new DshAdapter();
      expect(await adapter.identifyHost()).toBe(false);

      await fsp.mkdir(path.join(userHomeDir, ".dsh"), { recursive: true });
      expect(await adapter.identifyHost()).toBe(true);
    });
  });

  describe("Version & API Safety (§42)", () => {
    it("reports supported with mutation enabled for stable semantic version", async () => {
      const adapter = new DshAdapter();
      process.env.DSH_VERSION = "1.2.0";
      const info = await adapter.inspectVersion(workspaceDir);

      expect(info.version).toBe("1.2.0");
      expect(info.compatibility).toBe("supported");
      expect(info.fail_closed_for_mutation).toBe(false);
    });

    it("reports unknown-version with fail-closed mutation when unevidenced", async () => {
      const adapter = new DshAdapter();
      const info = await adapter.inspectVersion(workspaceDir);

      expect(info.version).toBeUndefined();
      expect(info.compatibility).toBe("unknown-version");
      expect(info.fail_closed_for_mutation).toBe(true);
    });

    it("reports partially-supported with fail-closed mutation for developer-preview version", async () => {
      const adapter = new DshAdapter();
      process.env.DSH_VERSION = "1.0.0-preview.3";
      const info = await adapter.inspectVersion(workspaceDir);

      expect(info.version).toBe("1.0.0-preview.3");
      expect(info.compatibility).toBe("partially-supported");
      expect(info.fail_closed_for_mutation).toBe(true);
    });

    it("reports fail-closed mutation when plugin API version is developer-preview", async () => {
      const adapter = new DshAdapter();
      process.env.DSH_VERSION = "1.0.0";
      process.env.DSH_PLUGIN_API_VERSION = "0.9.0-dev";
      const info = await adapter.inspectVersion(workspaceDir);

      expect(info.compatibility).toBe("partially-supported");
      expect(info.fail_closed_for_mutation).toBe(true);
    });

    it("enforces fail-closed mutation rejection on preview or unknown versions", async () => {
      const adapter = new DshAdapter();
      process.env.DSH_VERSION = "0.0.0-dev";

      // 1. Companion registration preview fails closed
      const preview = await adapter.previewCompanionRegistration(workspaceDir);
      expect(preview.supported).toBe(false);
      expect(preview.error).toContain("fail-closed version safety per SPEC §42");

      // 2. Companion registration apply fails closed
      const applyCompanion = await adapter.applyCompanionRegistration(
        "dummy-hash",
        workspaceDir
      );
      expect(applyCompanion.success).toBe(false);
      expect(applyCompanion.error).toContain("fail-closed version safety");

      // 3. Configuration apply fails closed
      const applyConfig = await adapter.applyConfiguration(
        "preview-123",
        {
          preview_id: "preview-123",
          mutation_targets: [path.join(workspaceDir, "dsh.config.json")],
          diff: "",
          files: [{ path: path.join(workspaceDir, "dsh.config.json"), content: "{}" }],
        },
        workspaceDir
      );
      expect(applyConfig.success).toBe(false);
      expect(applyConfig.error).toContain("fail-closed version safety");
    });
  });

  describe("Capability Model & DSH Presence Rule (§40)", () => {
    it("DSH presence alone does NOT imply subagents are available", async () => {
      const adapter = new DshAdapter();
      process.env.DSH_RUNTIME = "1";

      // DSH is identified as host
      expect(await adapter.identifyHost(workspaceDir)).toBe(true);

      // But no subagent plugin is loaded!
      const caps = await adapter.inspectCapabilities(workspaceDir);
      expect(caps.capabilities.subagents.state).toBe("unavailable");
      expect(caps.capabilities.per_agent_model_selection?.state).toBe("unavailable");

      const topology = await adapter.inspectExecutionTopologyCapabilities(workspaceDir);
      expect(topology.supports_subagents).toBe(false);
      expect(await adapter.inspectSubagentProviders(workspaceDir)).toEqual([]);
    });

    it("inspects active plugins from environment and configuration", async () => {
      const adapter = new DshAdapter();
      process.env.DSH_PLUGINS = "@dsh/plugin-llm,@dsh/plugin-mcp";

      const configFile = path.join(workspaceDir, "dsh.config.json");
      await fsp.writeFile(
        configFile,
        JSON.stringify({
          plugins: {
            "@dsh/plugin-sandboxes": {},
            "@dsh/plugin-tools": {},
          },
        }),
        "utf-8"
      );

      const activePlugins = await adapter.inspectActivePlugins(workspaceDir);
      expect(activePlugins).toContain("@dsh/plugin-llm");
      expect(activePlugins).toContain("@dsh/plugin-mcp");
      expect(activePlugins).toContain("@dsh/plugin-sandboxes");
      expect(activePlugins).toContain("@dsh/plugin-tools");
    });

    it("inspects mounted services from environment and active plugins", async () => {
      const adapter = new DshAdapter();
      process.env.DSH_SERVICES = "models,mcp,sandboxes";

      const services = await adapter.inspectMountedServices(workspaceDir);
      expect(services).toContain("models");
      expect(services).toContain("mcp");
      expect(services).toContain("sandboxes");
    });

    it("inspects active preset / mode", async () => {
      const adapter = new DshAdapter();
      process.env.DSH_PRESET = "coding";
      expect(await adapter.inspectActivePreset(workspaceDir)).toBe("coding");

      delete process.env.DSH_PRESET;
      process.env.DSH_MODE = "architect";
      expect(await adapter.inspectActivePreset(workspaceDir)).toBe("architect");
    });
  });

  describe("Subagent Providers (§41)", () => {
    it("reports only real active subagent providers from environment", async () => {
      const adapter = new DshAdapter();
      process.env.DSH_RUNTIME = "1";
      process.env.DSH_SUBAGENT_PROVIDERS = "in-process,fork";

      const providers = await adapter.inspectSubagentProviders(workspaceDir);
      expect(providers).toEqual(["in-process", "fork"]);

      const caps = await adapter.inspectCapabilities(workspaceDir);
      expect(caps.capabilities.subagents.state).toBe("available");
      expect(caps.capabilities.per_agent_model_selection?.state).toBe("available");

      const topology = await adapter.inspectExecutionTopologyCapabilities(workspaceDir);
      expect(topology.supports_subagents).toBe(true);
    });

    it("detects subagent providers from loaded subagent plugins", async () => {
      const adapter = new DshAdapter();
      process.env.DSH_RUNTIME = "1";
      process.env.DSH_PLUGINS = [
        "@dsh/plugin-subagent-fork",
        "@dsh/plugin-subagent-acp",
        "@dsh/plugin-subagent-codex",
        "@dsh/plugin-subagent-claude-code",
        "@dsh/plugin-subagent-dsh-sdk",
      ].join(",");

      const providers = await adapter.inspectSubagentProviders(workspaceDir);
      expect(providers).toContain("fork");
      expect(providers).toContain("acp");
      expect(providers).toContain("codex");
      expect(providers).toContain("claude-code");
      expect(providers).toContain("dsh-sdk");
      expect(providers).not.toContain("in-process");
    });

    it("detects subagent providers from configuration file", async () => {
      const adapter = new DshAdapter();
      const configFile = path.join(workspaceDir, "dsh.config.json");
      await fsp.writeFile(
        configFile,
        JSON.stringify({
          plugins: {
            "@dsh/plugin-subagents": {
              providers: ["in-process", "acp"],
            },
          },
        }),
        "utf-8"
      );

      const providers = await adapter.inspectSubagentProviders(workspaceDir);
      expect(providers).toContain("in-process");
      expect(providers).toContain("acp");
      expect(providers).not.toContain("fork");
    });
  });

  describe("Companion MCP Registration Lifecycle (§43)", () => {
    it("reports unregistered when MCP plugin is absent or server is missing", async () => {
      const adapter = new DshAdapter();
      const status = await adapter.inspectCompanionRegistration(workspaceDir);
      expect(status.registered).toBe(false);
    });

    it("executes complete preview, apply, and validate lifecycle", async () => {
      const adapter = new DshAdapter();
      process.env.DSH_VERSION = "1.0.0"; // Stable version permitting mutation

      // 1. Unregistered initially
      const initialStatus = await adapter.inspectCompanionRegistration(workspaceDir);
      expect(initialStatus.registered).toBe(false);

      // 2. Preview companion registration
      const preview = await adapter.previewCompanionRegistration(workspaceDir);
      expect(preview.supported).toBe(true);
      expect(preview.preview_hash).toBeDefined();
      expect(preview.mutation_targets).toHaveLength(1);
      expect(preview.diff).toContain("agent-config");

      // 3. Apply companion registration with hash
      const applyResult = await adapter.applyCompanionRegistration(
        preview.preview_hash!,
        workspaceDir
      );
      expect(applyResult.success).toBe(true);
      expect(applyResult.applied_targets).toHaveLength(1);

      // 4. Validate registration
      const valResult = await adapter.validateCompanionRegistration(workspaceDir);
      expect(valResult.valid).toBe(true);

      // 5. Verify inspectCompanionRegistration now sees it
      const status = await adapter.inspectCompanionRegistration(workspaceDir);
      expect(status.registered).toBe(true);
      expect(status.command).toBe("agent-config");
    });

    it("rejects apply with mismatched preview hash", async () => {
      const adapter = new DshAdapter();
      process.env.DSH_VERSION = "1.0.0";

      const applyResult = await adapter.applyCompanionRegistration(
        "mismatched-hash-xyz",
        workspaceDir
      );
      expect(applyResult.success).toBe(false);
      expect(applyResult.error).toContain("mismatch");
    });
  });

  describe("Configuration Render, Apply & Validation", () => {
    const samplePlan: ExecutionConfig = {
      execution_id: "dsh-exec-plan-01",
      controller: { model: "deepseek-chat", effort: "high" },
      execution: { model: "deepseek-chat", effort: "high" },
      work_items: [
        { ticket_id: "TICKET-01", model: "deepseek-chat", effort: "high" },
      ],
    };

    it("renders configuration and applies it to dsh.config.json", async () => {
      const adapter = new DshAdapter();
      process.env.DSH_VERSION = "1.0.0";

      const preview = await adapter.previewConfiguration(samplePlan, undefined, workspaceDir);
      expect(preview.preview_id).toBeDefined();
      expect(preview.files).toBeDefined();
      expect(preview.files![0].content).toContain("deepseek-chat");

      const applyResult = await adapter.applyConfiguration(
        preview.preview_id,
        preview,
        workspaceDir
      );
      expect(applyResult.success).toBe(true);

      const val = await adapter.validateConfiguration(samplePlan, workspaceDir);
      expect(val.valid).toBe(true);
    });

    it("resolves reasoning policy against evidenced options", async () => {
      const adapter = new DshAdapter();
      process.env.DSH_REASONING_EFFORT = "high";

      const resolved = await adapter.resolveReasoningPolicy(
        "highest-supported",
        "deepseek-chat",
        workspaceDir
      );
      expect(resolved).toBeDefined();
      expect(resolved?.host_field).toBe("reasoning_effort");
      expect(resolved?.host_value).toBe("high");
    });

    it("respects Cordis patch markers and scope targeting", async () => {
      const adapter = new DshAdapter();
      const cordisPatch = path.join(workspaceDir, "cordis.patch.yml");
      await fsp.writeFile(cordisPatch, "# Cordis patch overlay\n", "utf-8");

      expect(await adapter.identifyHost(workspaceDir)).toBe(true);

      const targetProject = adapter.determineTargetConfigPath(workspaceDir, "project");
      expect(targetProject).toBe(path.join(workspaceDir, "dsh.config.json"));

      const targetUser = adapter.determineTargetConfigPath(workspaceDir, "user");
      expect(targetUser).toContain("cordis.patch.yml");
    });
  });
});
