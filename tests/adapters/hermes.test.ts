import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { HermesAdapter } from "../../src/adapters/hermes/index.js";
import { ExecutionConfig } from "../../src/profile/schema.js";
import { createMockSubprocessRunner, MockSubprocessRunner } from "../harness/mock-runner.js";

describe("Hermes Native Adapter Tests (§49, §50, §51)", () => {
  let tempDir: string;
  let workspaceDir: string;
  let userHomeDir: string;
  let mockRunner: MockSubprocessRunner;
  let originalHome: string | undefined;
  let originalEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "hermes-adapter-test-"));
    workspaceDir = path.join(tempDir, "workspace");
    userHomeDir = path.join(tempDir, "home");
    await fsp.mkdir(workspaceDir, { recursive: true });
    await fsp.mkdir(userHomeDir, { recursive: true });

    mockRunner = createMockSubprocessRunner();
    mockRunner.installGlobalHook();

    originalHome = process.env.HOME;
    originalEnv = {
      HERMES_HOME: process.env.HERMES_HOME,
      HERMES_PROFILE: process.env.HERMES_PROFILE,
      HERMES_CONFIG: process.env.HERMES_CONFIG,
      HERMES_ENV: process.env.HERMES_ENV,
      HERMES_INFERENCE_MODEL: process.env.HERMES_INFERENCE_MODEL,
      HERMES_SESSION: process.env.HERMES_SESSION,
      HERMES_SESSION_ID: process.env.HERMES_SESSION_ID,
      HERMES_VERSION: process.env.HERMES_VERSION,
      HERMES_REASONING_EFFORT: process.env.HERMES_REASONING_EFFORT,
      HERMES_DELEGATION: process.env.HERMES_DELEGATION,
      HERMES_MAX_CONCURRENCY: process.env.HERMES_MAX_CONCURRENCY,
    };

    process.env.HOME = userHomeDir;
    delete process.env.HERMES_HOME;
    delete process.env.HERMES_PROFILE;
    delete process.env.HERMES_CONFIG;
    delete process.env.HERMES_ENV;
    delete process.env.HERMES_INFERENCE_MODEL;
    delete process.env.HERMES_SESSION;
    delete process.env.HERMES_SESSION_ID;
    delete process.env.HERMES_VERSION;
    delete process.env.HERMES_REASONING_EFFORT;
    delete process.env.HERMES_DELEGATION;
    delete process.env.HERMES_MAX_CONCURRENCY;
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
    it("identifies Hermes from environment variables", async () => {
      const adapter = new HermesAdapter();
      expect(adapter.hasActiveRuntimeContext(workspaceDir)).toBe(false);

      process.env.HERMES_PROFILE = "default";
      expect(adapter.hasActiveRuntimeContext(workspaceDir)).toBe(true);
      expect(await adapter.identifyHost(workspaceDir)).toBe(true);

      delete process.env.HERMES_PROFILE;
      process.env.HERMES_HOME = path.join(userHomeDir, ".hermes");
      expect(adapter.hasActiveRuntimeContext(workspaceDir)).toBe(true);
      expect(await adapter.identifyHost(workspaceDir)).toBe(true);
    });

    it("identifies Hermes from workspace .hermes directory or config.yaml", async () => {
      const adapter = new HermesAdapter();
      expect(await adapter.identifyHost(workspaceDir)).toBe(false);

      await fsp.mkdir(path.join(workspaceDir, ".hermes"), { recursive: true });
      expect(await adapter.identifyHost(workspaceDir)).toBe(true);
    });

    it("identifies Hermes from user home ~/.hermes when no workspace supplied", async () => {
      const adapter = new HermesAdapter();
      await fsp.mkdir(path.join(userHomeDir, ".hermes"), { recursive: true });
      expect(await adapter.identifyHost()).toBe(true);
    });
  });

  describe("Version Inspection & Compatibility", () => {
    it("reports unknown-version and fails closed when unevidenced", async () => {
      const adapter = new HermesAdapter();
      const version = await adapter.inspectVersion(workspaceDir);
      expect(version.compatibility).toBe("unknown-version");
      expect(version.fail_closed_for_mutation).toBe(true);
    });

    it("detects supported version from HERMES_VERSION env (0.x)", async () => {
      process.env.HERMES_VERSION = "0.21.0";
      const adapter = new HermesAdapter();
      const version = await adapter.inspectVersion(workspaceDir);
      expect(version.compatibility).toBe("supported");
      expect(version.fail_closed_for_mutation).toBe(false);
      expect(version.version).toBe("0.21.0");
    });

    it("detects version from CLI hermes -V", async () => {
      mockRunner.register("hermes", {
        exitCode: 0,
        stdout: "Hermes Agent v0.21.0 (2026.8.31) · upstream 79445a49",
      }, [/-V/]);

      const adapter = new HermesAdapter();
      const version = await adapter.inspectVersion(workspaceDir);
      expect(version.compatibility).toBe("supported");
      expect(version.version).toBe("0.21.0");
    });
  });

  describe("Model Resources & Provider Inspection (§50)", () => {
    it("inspects active model, aliases, delegation, custom providers, and MOA reference models", async () => {
      const hermesDir = path.join(workspaceDir, ".hermes");
      await fsp.mkdir(hermesDir, { recursive: true });

      const yamlContent = `model:
  default: gemini-3.8-flash-high
  provider: custom:cpa-gui
  aliases:
    local: omlx/Qwen3.8-9B-mlx-4Bit
providers:
  omlx:
    models:
      - Qwen3.8-9B-mlx-4Bit
custom_providers:
  - name: cpa-gui
    models:
      claude-sonnet-4-6: {}
      gpt-5.5: {}
delegation:
  model: omlx/Qwen3.8-9B-mlx-4Bit
  max_concurrent_children: 4
moa:
  reference_models:
    - model: deepseek/deepseek-v4-pro
`;
      await fsp.writeFile(path.join(hermesDir, "config.yaml"), yamlContent, "utf-8");

      const adapter = new HermesAdapter();
      const models = await adapter.inspectModels(workspaceDir);

      expect(models.length).toBeGreaterThanOrEqual(5);
      const modelIds = models.map((m) => m.id);
      expect(modelIds).toContain("gemini-3.8-flash-high");
      expect(modelIds).toContain("omlx/Qwen3.8-9B-mlx-4Bit");
      expect(modelIds).toContain("claude-sonnet-4-6");
      expect(modelIds).toContain("gpt-5.5");
      expect(modelIds).toContain("deepseek/deepseek-v4-pro");

      // Verify capabilities
      const caps = await adapter.inspectCapabilities(workspaceDir);
      expect(caps.capabilities.subagents.state).toBe("available");
      expect(caps.capabilities.parallelism.state).toBe("available");
      expect(caps.capabilities.concurrency?.max_concurrency).toBe(4);
      expect(caps.capabilities.per_agent_model_selection?.state).toBe("available");
    });
  });

  describe("Companion MCP Registration Lifecycle", () => {
    it("previews and registers companion in project scope config.yaml", async () => {
      const hermesDir = path.join(workspaceDir, ".hermes");
      await fsp.mkdir(hermesDir, { recursive: true });
      await fsp.writeFile(
        path.join(hermesDir, "config.yaml"),
        "model:\n  default: gemini-3.8-flash-high\n",
        "utf-8"
      );

      const adapter = new HermesAdapter();
      const preview = await adapter.previewCompanionRegistration(workspaceDir, "project");

      expect(preview.supported).toBe(true);
      expect(preview.mutation_targets).toEqual([path.join(hermesDir, "config.yaml")]);
      expect(preview.diff).toContain("agent-config");

      // Apply with fallback to YAML
      const applyResult = await adapter.applyCompanionRegistration(preview.preview_hash!, workspaceDir, preview);
      expect(applyResult.success).toBe(true);

      const updated = await fsp.readFile(path.join(hermesDir, "config.yaml"), "utf-8");
      expect(updated).toContain("mcp_servers:");
      expect(updated).toContain("agent-config:");

      const validation = await adapter.validateCompanionRegistration(workspaceDir);
      expect(validation.valid).toBe(true);
    });

    it("previews and registers companion in user scope config.yaml", async () => {
      const userHermesDir = path.join(userHomeDir, ".hermes");
      await fsp.mkdir(userHermesDir, { recursive: true });
      await fsp.writeFile(
        path.join(userHermesDir, "config.yaml"),
        "model:\n  default: gemini-3.8-flash-high\n",
        "utf-8"
      );

      const adapter = new HermesAdapter();
      const preview = await adapter.previewCompanionRegistration(workspaceDir, "user");

      expect(preview.supported).toBe(true);
      expect(preview.mutation_targets).toEqual([path.join(userHermesDir, "config.yaml")]);

      const applyResult = await adapter.applyCompanionRegistration(preview.preview_hash!, workspaceDir, preview);
      expect(applyResult.success).toBe(true);

      const updated = await fsp.readFile(path.join(userHermesDir, "config.yaml"), "utf-8");
      expect(updated).toContain("agent-config:");
    });
  });

  describe("Configuration Lifecycle & Validation", () => {
    it("renders, applies, and validates single-model and reasoning effort", async () => {
      process.env.HERMES_VERSION = "0.21.0";
      const hermesDir = path.join(workspaceDir, ".hermes");
      await fsp.mkdir(hermesDir, { recursive: true });
      await fsp.writeFile(
        path.join(hermesDir, "config.yaml"),
        "model:\n  default: old-model\n",
        "utf-8"
      );

      const adapter = new HermesAdapter();
      const plan: ExecutionConfig = {
        execution_id: "plan-hermes",
        controller: { model: "gemini-3.8-flash-high", effort: "high" },
        execution: { model: "gemini-3.8-flash-high", effort: "high" },
      };

      const rendered = await adapter.renderConfiguration(plan, undefined, workspaceDir);
      expect(rendered.mutation_targets).toEqual([path.join(hermesDir, "config.yaml")]);

      const apply = await adapter.applyConfiguration(rendered.preview_id, rendered, workspaceDir);
      expect(apply.success).toBe(true);

      const updated = await fsp.readFile(path.join(hermesDir, "config.yaml"), "utf-8");
      expect(updated).toContain("gemini-3.8-flash-high");
      expect(updated).toContain("reasoning_effort: high");

      const validation = await adapter.validateConfiguration(plan, workspaceDir);
      expect(validation.valid).toBe(true);
    });
  });
});
