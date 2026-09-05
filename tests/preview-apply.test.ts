import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { PreviewManager } from "../src/server/preview.js";
import { AdapterRegistry } from "../src/adapters/registry.js";
import { ProfileStore } from "../src/profile/store.js";
import {
  handlePreviewConfiguration,
  handleApplyConfiguration,
  handleValidateConfiguration,
} from "../src/server/tools/index.js";
import { ExecutionConfig, Profile } from "../src/profile/schema.js";
import { HostAdapter } from "../src/adapters/contract.js";

describe("Preview-Apply Lifecycle & Drift Verification", () => {
  let tempDir: string;
  let workspaceDir: string;
  let previewManager: PreviewManager;
  let adapterRegistry: AdapterRegistry;
  let profileStore: ProfileStore;

  const codexSinglePlan: ExecutionConfig = {
    task_shape: "single-pass",
    model_mode: "single",
    readiness: "executable",
    topology: {
      type: "single-session",
      concurrency: 1,
    },
    execution: {
      model: "gpt-5.6-sol",
      effort: "high",
      effort_policy: "highest-supported",
      context: "current-session",
    },
    review: {
      strategy: "self-check",
      model: "gpt-5.6-sol",
      effort: "high",
      context: "current-session",
    },
  };

  const codexDecomposedPlan: ExecutionConfig = {
    task_shape: "decomposed",
    model_mode: "multi",
    readiness: "executable",
    topology: {
      type: "controller-workers",
      concurrency: 2,
    },
    controller: {
      model: "gpt-5.6-sol",
      effort: "high",
      context: "main-session",
    },
    work_items: [
      {
        ticket_id: "01-infra",
        difficulty: "routine",
        model: "gpt-5.6-luna",
        effort: "low",
        context: "worker-1",
      },
      {
        ticket_id: "02-features",
        difficulty: "demanding",
        model: "gpt-5.6-terra",
        effort: "high",
        context: "worker-2",
      },
    ],
    review: {
      strategy: "independent-review",
      model: "gpt-5.6-sol",
      effort: "high",
      context: "fresh-session",
    },
  };

  const openCodeSinglePlan: ExecutionConfig = {
    task_shape: "single-pass",
    model_mode: "single",
    readiness: "executable",
    topology: {
      type: "single-session",
      concurrency: 1,
    },
    execution: {
      model: "cpa-gui/gemini-3.8-flash-high",
      effort: "high",
      effort_policy: "highest-supported",
      context: "current-session",
    },
    review: {
      strategy: "self-check",
      model: "cpa-gui/gemini-3.8-flash-high",
      effort: "high",
      context: "current-session",
    },
  };

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-config-preview-apply-test-"));
    workspaceDir = path.join(tempDir, "workspace");
    await fsp.mkdir(workspaceDir, { recursive: true });

    previewManager = new PreviewManager();
    adapterRegistry = new AdapterRegistry();
    profileStore = new ProfileStore({ baseDir: path.join(tempDir, "profiles") });
  });

  afterEach(async () => {
    delete process.env.CODEX_MODEL;
    delete process.env.CODEX_HOME;
    if (fs.existsSync(tempDir)) {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  function getContext() {
    return { previewManager, adapterRegistry, profileStore };
  }

  async function setupCodexHost(workspace: string, decomposed: boolean = false) {
    await fsp.mkdir(path.join(workspace, ".codex", "agents"), { recursive: true });
    await fsp.mkdir(path.join(workspace, ".codex", "sessions"), { recursive: true });
    const config =
      'model = "old-model"\nmodel_reasoning_effort = "low"\nmax_concurrency = 4\nsupported_models = ["old-model", "old-project-model", "gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.6-terra"]\n[agents]\nmax_threads = 4\n';
    await fsp.writeFile(path.join(workspace, ".codex", "config.toml"), config, "utf-8");

    const profile: Profile = decomposed
      ? {
          profile_version: 1,
          host: { id: "codex", adapter: "codex" },
          scope: { type: "project", workspace },
          model_mode: "multi",
          tiers: {
            routine: { model: "gpt-5.6-luna", effort: { value: "low" }, source: "user-confirmed" },
            standard: { model: "gpt-5.6-terra", effort: { value: "high" }, source: "user-confirmed" },
            high: { model: "gpt-5.6-sol", effort: { value: "high" }, source: "user-confirmed" },
            review: { model: "gpt-5.6-sol", effort: { value: "high" }, source: "user-confirmed" },
          },
          capabilities: {
            subagents: "available",
            threads: "available",
            parallelism: "available",
          },
        }
      : {
          profile_version: 1,
          host: { id: "codex", adapter: "codex" },
          scope: { type: "project", workspace },
          model_mode: "single",
          single_model: {
            model: "gpt-5.6-sol",
            execution_effort: { policy: "highest-supported" },
          },
          capabilities: {
            subagents: "available",
            threads: "available",
            parallelism: "available",
          },
        };
    await profileStore.saveProfile(profile);
  }

  async function setupOpenCodeHost(workspace: string) {
    const config = {
      model: "cpa-gui/gemini-3.8-flash-high",
      models: ["cpa-gui/gemini-3.8-flash-high"],
    };
    await fsp.writeFile(
      path.join(workspace, "opencode.json"),
      JSON.stringify(config, null, 2),
      "utf-8"
    );

    const profile: Profile = {
      profile_version: 1,
      host: { id: "opencode", adapter: "opencode" },
      scope: { type: "project", workspace },
      model_mode: "single",
      single_model: {
        model: "cpa-gui/gemini-3.8-flash-high",
        execution_effort: { policy: "highest-supported" },
      },
      capabilities: {
        subagents: "available",
        threads: "available",
        parallelism: "available",
      },
    };
    await profileStore.saveProfile(profile);
  }

  describe("Preview Generation & Hash Recording", () => {
    it("generates a preview with deterministic preview_id and records target hashes", async () => {
      await setupCodexHost(workspaceDir);

      const preview = await handlePreviewConfiguration(
        { config: codexSinglePlan, workspace: workspaceDir },
        getContext()
      );

      expect(preview.preview_id).toBeDefined();
      expect(preview.diff).toContain("-model = \"old-model\"");
      expect(preview.diff).toContain("+model = \"gpt-5.6-sol\"");
      expect(preview.mutation_targets).toEqual([
        path.join(workspaceDir, ".codex", "config.toml"),
      ]);

      const stored = previewManager.getPreview(preview.preview_id);
      expect(stored).toBeDefined();
      expect(stored?.applied).toBe(false);
      expect(stored?.target_hashes[path.join(workspaceDir, ".codex", "config.toml")]).not.toBeNull();

      // Verify FrozenMutationPreview properties (§26, §27)
      expect(stored?.adapter_id).toBe("codex");
      expect(stored?.host_identity).toBe("codex");
      expect(stored?.scope).toBe("project");
      expect(stored?.target).toBe(path.join(workspaceDir, ".codex", "config.toml"));
      expect(stored?.baseline_hash).toBeDefined();
      expect(stored?.mutation.diff).toBe(preview.diff);
      expect(stored?.created_at).toBeDefined();
      expect(stored?.expires_at).toBeDefined();
    });
  });

  describe("Apply Security & Rejection Guards", () => {
    it("rejects apply when preview_id does not exist", async () => {
      await expect(
        handleApplyConfiguration(
          { preview_id: "unknown-preview-id-12345", workspace: workspaceDir },
          getContext()
        )
      ).rejects.toThrow(/not found or has expired/);
    });

    it("rejects apply when requested workspace does not match preview workspace", async () => {
      await setupCodexHost(workspaceDir);
      const otherWorkspace = path.join(tempDir, "other-workspace");
      await fsp.mkdir(otherWorkspace, { recursive: true });

      const preview = await handlePreviewConfiguration(
        { config: codexSinglePlan, workspace: workspaceDir },
        getContext()
      );

      await expect(
        handleApplyConfiguration(
          { preview_id: preview.preview_id, workspace: otherWorkspace },
          getContext()
        )
      ).rejects.toThrow(/Workspace mismatch/);
    });

    it("rejects apply when preview has already been applied (single-use guard)", async () => {
      await setupCodexHost(workspaceDir);

      const preview = await handlePreviewConfiguration(
        { config: codexSinglePlan, workspace: workspaceDir },
        getContext()
      );

      // First apply succeeds
      const firstApply = await handleApplyConfiguration(
        { preview_id: preview.preview_id, workspace: workspaceDir },
        getContext()
      );
      expect(firstApply.success).toBe(true);

      // Second apply is rejected
      await expect(
        handleApplyConfiguration(
          { preview_id: preview.preview_id, workspace: workspaceDir },
          getContext()
        )
      ).rejects.toThrow(/already been applied/);
    });

    it("rejects apply when target file has been modified externally between preview and apply (anti-drift guard)", async () => {
      await setupCodexHost(workspaceDir);
      const targetFile = path.join(workspaceDir, ".codex", "config.toml");

      // Generate preview
      const preview = await handlePreviewConfiguration(
        { config: codexSinglePlan, workspace: workspaceDir },
        getContext()
      );

      // Drift: someone modifies target file after preview
      await fsp.writeFile(targetFile, 'model = "model-tampered"\n', "utf-8");

      // Apply must be rejected
      await expect(
        handleApplyConfiguration(
          { preview_id: preview.preview_id, workspace: workspaceDir },
          getContext()
        )
      ).rejects.toThrow(/has changed since preview was generated/);
    });

    it("rejects apply when target file was absent during preview but created before apply", async () => {
      await fsp.mkdir(path.join(workspaceDir, ".codex"), { recursive: true });
      // Root codex.toml evidences model on host
      await fsp.writeFile(
        path.join(workspaceDir, "codex.toml"),
        'model = "gpt-5.6-sol"\n',
        "utf-8"
      );

      const profile: Profile = {
        profile_version: 1,
        host: { id: "codex", adapter: "codex" },
        scope: { type: "project", workspace: workspaceDir },
        model_mode: "single",
        single_model: {
          model: "gpt-5.6-sol",
          execution_effort: { policy: "highest-supported" },
        },
        capabilities: {
          subagents: "available",
          threads: "available",
          parallelism: "available",
        },
      };
      await profileStore.saveProfile(profile);

      const targetFile = path.join(workspaceDir, ".codex", "config.toml");
      expect(fs.existsSync(targetFile)).toBe(false);

      const preview = await handlePreviewConfiguration(
        { config: codexSinglePlan, workspace: workspaceDir },
        getContext()
      );

      // Create file before apply
      await fsp.writeFile(targetFile, 'model = "surprise"\n', "utf-8");

      // Apply must be rejected because initial hash was null and now is non-null
      await expect(
        handleApplyConfiguration(
          { preview_id: preview.preview_id, workspace: workspaceDir },
          getContext()
        )
      ).rejects.toThrow(/has changed since preview was generated/);
    });

    it("rejects apply when host version drifts between preview and apply (stale preview guard per SPEC §31)", async () => {
      await setupCodexHost(workspaceDir);

      const preview = await handlePreviewConfiguration(
        { config: codexSinglePlan, workspace: workspaceDir },
        getContext()
      );

      const stored = previewManager.getPreview(preview.preview_id);
      expect(stored).toBeDefined();
      if (stored) {
        // Simulate preview was captured with host_version 0.1.0
        stored.host_version = "0.1.0-stale";
      }

      await expect(
        handleApplyConfiguration(
          { preview_id: preview.preview_id, workspace: workspaceDir },
          getContext()
        )
      ).rejects.toThrow(/Stale preview: host version drifted/);
    });
  });

  describe("Complete Apply & Post-Apply State Validation", () => {
    it("applies Codex single-pass configuration and validates post-apply state", async () => {
      await setupCodexHost(workspaceDir);

      const preview = await handlePreviewConfiguration(
        { config: codexSinglePlan, workspace: workspaceDir },
        getContext()
      );

      const apply = await handleApplyConfiguration(
        { preview_id: preview.preview_id, workspace: workspaceDir },
        getContext()
      );
      expect(apply.success).toBe(true);

      // Validate post-apply state using preview_id
      const val = await handleValidateConfiguration(
        { preview_id: preview.preview_id, workspace: workspaceDir },
        getContext()
      );
      expect(val.valid).toBe(true);

      // Validate post-apply state using explicit expected_config
      const valExplicit = await handleValidateConfiguration(
        { expected_config: codexSinglePlan, workspace: workspaceDir },
        getContext()
      );
      expect(valExplicit.valid).toBe(true);
    });

    it("detects post-apply configuration drift when files are tampered with after apply", async () => {
      await setupCodexHost(workspaceDir);

      const preview = await handlePreviewConfiguration(
        { config: codexSinglePlan, workspace: workspaceDir },
        getContext()
      );
      await handleApplyConfiguration(
        { preview_id: preview.preview_id, workspace: workspaceDir },
        getContext()
      );

      // Verify valid initially
      const valBefore = await handleValidateConfiguration(
        { expected_config: codexSinglePlan, workspace: workspaceDir },
        getContext()
      );
      expect(valBefore.valid).toBe(true);

      // Tamper with file
      const configFile = path.join(workspaceDir, ".codex", "config.toml");
      await fsp.writeFile(configFile, 'model = "drifted-model"\nmodel_reasoning_effort = "low"\n', "utf-8");

      // Post-apply validation should now fail
      const valAfter = await handleValidateConfiguration(
        { expected_config: codexSinglePlan, workspace: workspaceDir },
        getContext()
      );
      expect(valAfter.valid).toBe(false);
      expect(valAfter.details).toBeDefined();
    });

    it("applies Codex decomposed configuration with multiple subagent tomls and detects subagent drift", async () => {
      await setupCodexHost(workspaceDir, true);

      const preview = await handlePreviewConfiguration(
        { config: codexDecomposedPlan, workspace: workspaceDir },
        getContext()
      );

      expect(preview.mutation_targets).toHaveLength(3);

      const apply = await handleApplyConfiguration(
        { preview_id: preview.preview_id, workspace: workspaceDir },
        getContext()
      );
      expect(apply.success).toBe(true);

      // Verify all files were created
      expect(fs.existsSync(path.join(workspaceDir, ".codex", "config.toml"))).toBe(true);
      expect(fs.existsSync(path.join(workspaceDir, ".codex", "agents", "01-infra.toml"))).toBe(true);
      expect(fs.existsSync(path.join(workspaceDir, ".codex", "agents", "02-features.toml"))).toBe(true);

      const val = await handleValidateConfiguration(
        { expected_config: codexDecomposedPlan, workspace: workspaceDir },
        getContext()
      );
      expect(val.valid).toBe(true);

      // Tamper with second agent file
      await fsp.writeFile(
        path.join(workspaceDir, ".codex", "agents", "02-features.toml"),
        'name = "02-features"\nmodel = "compromised-model"\n',
        "utf-8"
      );

      const valTampered = await handleValidateConfiguration(
        { expected_config: codexDecomposedPlan, workspace: workspaceDir },
        getContext()
      );
      expect(valTampered.valid).toBe(false);
      expect(JSON.stringify(valTampered.details)).toContain("model mismatch");
    });

    it("applies OpenCode configuration and detects JSON drift", async () => {
      await setupOpenCodeHost(workspaceDir);

      const preview = await handlePreviewConfiguration(
        { config: openCodeSinglePlan, workspace: workspaceDir },
        getContext()
      );

      const apply = await handleApplyConfiguration(
        { preview_id: preview.preview_id, workspace: workspaceDir },
        getContext()
      );
      expect(apply.success).toBe(true);

      const val = await handleValidateConfiguration(
        { expected_config: openCodeSinglePlan, workspace: workspaceDir },
        getContext()
      );
      expect(val.valid).toBe(true);

      // Alter opencode.json
      await fsp.writeFile(
        path.join(workspaceDir, "opencode.json"),
        JSON.stringify({ model: "different-model" }),
        "utf-8"
      );

      const valDrift = await handleValidateConfiguration(
        { expected_config: openCodeSinglePlan, workspace: workspaceDir },
        getContext()
      );
      expect(valDrift.valid).toBe(false);
    });

    it("handles Generic adapter plan-only preview, apply, and validate without filesystem mutation", async () => {
      const planOnlyAdapter: HostAdapter = {
        id: "generic",
        identifyHost: async () => false,
        inspectVersion: async () => ({
          version: "1.0",
          compatibility: "supported",
          fail_closed_for_mutation: true,
        }),
        inspectCapabilities: async () => ({
          host_id: "generic",
          adapter_id: "generic",
          observed_at: new Date().toISOString(),
          available_models: [{ id: "gpt-5.6-sol", state: "available" as const }],
          supported_effort_values: ["high"],
          capabilities: {
            subagents: { state: "unavailable" },
            threads: { state: "unavailable" },
            parallelism: { state: "unavailable" },
            model_selection: { state: "available", scopes: ["current-session"] },
            configuration_mutation: {
              state: "unavailable",
              supports_native_files: false,
              supports_session_mutation: false,
            },
          },
        }),
        renderConfiguration: async () => ({
          preview_id: "preview-plan-only-1",
          mutation_targets: [],
          diff: "Plan-Only Configuration",
        }),
        applyConfiguration: async (previewId) => ({
          success: true,
          preview_id: previewId,
          applied_targets: [],
          message: "Plan-Only Configuration applied without mutation",
        }),
        validateConfiguration: async () => ({ valid: true }),
        inspectCompanionRegistration: async () => ({ registered: false }),
        previewCompanionRegistration: async () => ({ supported: false, target_file: "", diff: "", mutation_targets: [] }),
        applyCompanionRegistration: async () => ({ success: false }),
        validateCompanionRegistration: async () => ({ valid: false }),
      };
      const planOnlyRegistry = new AdapterRegistry(planOnlyAdapter);
      const ctx = { previewManager, adapterRegistry: planOnlyRegistry, profileStore };

      await profileStore.saveProfile({
        profile_version: 1,
        host: { id: "generic", adapter: "generic" },
        scope: { type: "project", workspace: workspaceDir },
        model_mode: "single",
        single_model: {
          model: "gpt-5.6-sol",
          execution_effort: { policy: "highest-supported" },
        },
      });

      const preview = await handlePreviewConfiguration(
        { config: codexSinglePlan, workspace: workspaceDir },
        ctx
      );

      expect(preview.mutation_targets).toHaveLength(0);
      expect(preview.diff).toContain("Plan-Only");

      const apply = await handleApplyConfiguration(
        { preview_id: preview.preview_id, workspace: workspaceDir },
        ctx
      );
      expect(apply.success).toBe(true);
      expect(apply.applied_targets).toHaveLength(0);

      // Verify no files were created in workspaceDir
      const files = await fsp.readdir(workspaceDir);
      expect(files).toHaveLength(0);

      const val = await handleValidateConfiguration(
        { expected_config: codexSinglePlan, workspace: workspaceDir },
        ctx
      );
      expect(val.valid).toBe(true);
    });

    it("ensures scope preservation between project and user/global targets without scope drop (SPEC §28)", async () => {
      await setupCodexHost(workspaceDir);
      const projectTarget = path.join(workspaceDir, ".codex", "config.toml");

      const preview = await handlePreviewConfiguration(
        { config: codexSinglePlan, workspace: workspaceDir },
        getContext()
      );

      expect(preview.target).toBe(projectTarget);

      const apply = await handleApplyConfiguration(
        { preview_id: preview.preview_id, workspace: workspaceDir },
        getContext()
      );

      expect(apply.success).toBe(true);
      expect(apply.applied_targets).toEqual([projectTarget]);
      // Verify content was applied to projectTarget and did NOT drop to global user scope
      const projectContent = await fsp.readFile(projectTarget, "utf-8");
      expect(projectContent).toContain("gpt-5.6-sol");
    });
  });
});
