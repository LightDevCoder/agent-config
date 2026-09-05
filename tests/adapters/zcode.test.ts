import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ZCodeAdapter } from "../../src/adapters/zcode/index.js";
import { ExecutionConfig } from "../../src/profile/schema.js";

describe("ZCode Native Host Adapter (§2, §7, §10, §45)", () => {
  let tempDir: string;
  let workspaceDir: string;
  let originalEnv: {
    ZCODE_SESSION_ID?: string;
    ZCODE?: string;
    ZCODE_CONFIG?: string;
    ZCODE_VERSION?: string;
  };

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "zcode-test-"));
    workspaceDir = path.join(tempDir, "workspace");
    await fsp.mkdir(workspaceDir, { recursive: true });

    originalEnv = {
      ZCODE_SESSION_ID: process.env.ZCODE_SESSION_ID,
      ZCODE: process.env.ZCODE,
      ZCODE_CONFIG: process.env.ZCODE_CONFIG,
      ZCODE_VERSION: process.env.ZCODE_VERSION,
    };

    delete process.env.ZCODE_SESSION_ID;
    delete process.env.ZCODE;
    delete process.env.ZCODE_CONFIG;
    delete process.env.ZCODE_VERSION;
  });

  afterEach(async () => {
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v === undefined) delete (process.env as any)[k];
      else (process.env as any)[k] = v;
    }

    if (fs.existsSync(tempDir)) {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  describe("Identity & Detection (§7, §45)", () => {
    it("identifies host from active runtime indicators", async () => {
      const adapter = new ZCodeAdapter();
      expect(adapter.hasActiveRuntimeContext()).toBe(false);

      process.env.ZCODE_SESSION_ID = "test-session-123";
      expect(adapter.hasActiveRuntimeContext()).toBe(true);
      expect(await adapter.identifyHost()).toBe(true);
    });

    it("identifies host from workspace .zcode directory or zcode.json", async () => {
      const adapter = new ZCodeAdapter();
      await fsp.mkdir(path.join(workspaceDir, ".zcode"), { recursive: true });
      expect(await adapter.identifyHost(workspaceDir)).toBe(true);
    });

    it("identifies host from installed desktop app or user .zcode directory when workspace is not specified", async () => {
      const adapter = new ZCodeAdapter();
      // On macOS, /Applications/ZCode.app and ~/.zcode exist on host
      const detected = await adapter.identifyHost();
      expect(detected).toBe(true);
    });
  });

  describe("Version Inspection & Compatibility (§21, §22)", () => {
    it("reports supported for version 0.x / 1.x / 2.x / 3.x", async () => {
      process.env.ZCODE_VERSION = "0.16.5";
      const adapter = new ZCodeAdapter();
      const info = await adapter.inspectVersion(workspaceDir);
      expect(info.version).toBe("0.16.5");
      expect(info.compatibility).toBe("supported");
      expect(info.fail_closed_for_mutation).toBe(false);
    });

    it("fails closed on incompatible or unknown version", async () => {
      process.env.ZCODE_VERSION = "incompatible";
      const adapter = new ZCodeAdapter();
      const info = await adapter.inspectVersion(workspaceDir);
      expect(info.compatibility).toBe("incompatible");
      expect(info.fail_closed_for_mutation).toBe(true);
    });
  });

  describe("Model & Capabilities Inspection (§10, §45)", () => {
    it("enumerates models and reasoning variants from config", async () => {
      const configDir = path.join(workspaceDir, ".zcode");
      await fsp.mkdir(configDir, { recursive: true });
      await fsp.writeFile(
        path.join(configDir, "config.json"),
        JSON.stringify({
          provider: {
            "builtin:bigmodel": {
              models: {
                "GLM-5.3": {
                  reasoning: {
                    variants: ["low", "max", "high"],
                  },
                },
              },
            },
          },
        }, null, 2),
        "utf-8"
      );

      const adapter = new ZCodeAdapter();
      const models = await adapter.inspectModels(workspaceDir);
      expect(models.some((m) => m.id === "builtin:bigmodel/GLM-5.3")).toBe(true);

      const glm = models.find((m) => m.id === "builtin:bigmodel/GLM-5.3");
      expect(glm?.features).toContain("variant:max");
      expect(glm?.features).toContain("variant:low");

      const effortValues = await adapter.inspectEffortValues(workspaceDir);
      expect(effortValues).toContain("max");
      expect(effortValues).toContain("low");

      const highest = await adapter.resolveReasoningPolicy("highest-supported", "builtin:bigmodel/GLM-5.3", workspaceDir);
      expect(highest).toEqual({
        host_field: "reasoning",
        host_value: "max",
      });
    });

    it("inspects topology capabilities including subagents and parallelism", async () => {
      const adapter = new ZCodeAdapter();
      const topo = await adapter.inspectExecutionTopologyCapabilities(workspaceDir);
      expect(topo.supports_single_session).toBe(true);
      expect(topo.supports_subagents).toBe(true);
      expect(topo.supports_multi_agent).toBe(true);
      // Parallel execution is false because concurrency limit is unknown per strict unknown semantics
      expect(topo.supports_parallel_execution).toBe(false);
    });
  });

  describe("Companion MCP Registration & Mutation Preview (§45)", () => {
    it("previews and applies companion registration to workspace config", async () => {
      const adapter = new ZCodeAdapter();
      const preview = await adapter.previewCompanionRegistration(workspaceDir, "project");

      expect(preview.supported).toBe(true);
      expect(preview.mutation_targets.length).toBe(1);
      expect(preview.preview_hash).toBeDefined();

      const result = await adapter.applyCompanionRegistration(preview.preview_hash!, workspaceDir, preview);
      expect(result.success).toBe(true);

      const status = await adapter.inspectCompanionRegistration(workspaceDir, "project");
      expect(status.registered).toBe(true);
      expect(status.command).toBe("agent-config");

      const valid = await adapter.validateCompanionRegistration(workspaceDir);
      expect(valid.valid).toBe(true);
    });
  });

  describe("Configuration Rendering, Apply, and Validation (§45)", () => {
    it("renders, applies, and validates execution configuration", async () => {
      const adapter = new ZCodeAdapter();
      const plan: ExecutionConfig = {
        task_shape: "single-pass",
        model_mode: "single",
        readiness: "executable",
        topology: { type: "single-session", concurrency: 1 },
        execution: { model: "builtin:bigmodel/GLM-5.3", effort: "highest-supported", context: "main" },
        review: { strategy: "self-check", model: "builtin:bigmodel/GLM-5.3", context: "main" },
      };

      const rendered = await adapter.renderConfiguration(plan, undefined, workspaceDir, "project");
      expect(rendered.mutation_targets.length).toBe(1);

      const applyRes = await adapter.applyConfiguration(rendered.preview_id, rendered, workspaceDir);
      expect(applyRes.success).toBe(true);

      const validation = await adapter.validateConfiguration(plan, workspaceDir);
      expect(validation.valid).toBe(true);
    });
  });
});
