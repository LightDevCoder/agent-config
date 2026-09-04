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
import { ExecutionConfig } from "../src/profile/schema.js";

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
    if (fs.existsSync(tempDir)) {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  function getContext() {
    return { previewManager, adapterRegistry, profileStore };
  }

  describe("Preview Generation & Hash Recording", () => {
    it("generates a preview with deterministic preview_id and records target hashes", async () => {
      // Set up a mock codex workspace
      await fsp.mkdir(path.join(workspaceDir, ".codex"), { recursive: true });
      const initialConfig = 'model = "old-model"\nmodel_reasoning_effort = "low"\n';
      await fsp.writeFile(
        path.join(workspaceDir, ".codex", "config.toml"),
        initialConfig,
        "utf-8"
      );

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
      await fsp.mkdir(path.join(workspaceDir, ".codex"), { recursive: true });

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
      await fsp.mkdir(path.join(workspaceDir, ".codex"), { recursive: true });
      const targetFile = path.join(workspaceDir, ".codex", "config.toml");
      await fsp.writeFile(targetFile, 'model = "model-v1"\n', "utf-8");

      // Generate preview
      const preview = await handlePreviewConfiguration(
        { config: codexSinglePlan, workspace: workspaceDir },
        getContext()
      );

      // Drift: someone modifies or commits to target file in the meantime
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
      const targetFile = path.join(workspaceDir, ".codex", "config.toml");

      // Target file does not exist initially
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
  });

  describe("Complete Apply & Post-Apply State Validation", () => {
    it("applies Codex single-pass configuration and validates post-apply state", async () => {
      await fsp.mkdir(path.join(workspaceDir, ".codex"), { recursive: true });

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
      await fsp.mkdir(path.join(workspaceDir, ".codex"), { recursive: true });

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
      await fsp.mkdir(path.join(workspaceDir, ".codex"), { recursive: true });

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
      await fsp.writeFile(path.join(workspaceDir, "opencode.json"), "{}", "utf-8");

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
      // Empty workspace without .codex or opencode.json resolves to Generic adapter
      const preview = await handlePreviewConfiguration(
        { config: codexSinglePlan, workspace: workspaceDir },
        getContext()
      );

      expect(preview.mutation_targets).toHaveLength(0);
      expect(preview.diff).toContain("Plan-Only");

      const apply = await handleApplyConfiguration(
        { preview_id: preview.preview_id, workspace: workspaceDir },
        getContext()
      );
      expect(apply.success).toBe(true);
      expect(apply.applied_targets).toHaveLength(0);

      // Verify no files were created in workspaceDir
      const files = await fsp.readdir(workspaceDir);
      expect(files).toHaveLength(0);

      const val = await handleValidateConfiguration(
        { expected_config: codexSinglePlan, workspace: workspaceDir },
        getContext()
      );
      expect(val.valid).toBe(true);
    });
  });
});
