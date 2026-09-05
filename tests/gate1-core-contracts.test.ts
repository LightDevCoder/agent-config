import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { ProfileStore } from "../src/profile/store.js";
import { Profile, ExecutionConfig, ExecutionConfigSchema, createAgentConfigResult, AgentConfigResultSchema } from "../src/profile/schema.js";
import { HostCapabilities } from "../src/adapters/contract.js";
import { validateExecutionConfig } from "../src/profile/validator.js";
import { PreviewManager, StoredPreview } from "../src/server/preview.js";
import { handleSaveProfile } from "../src/server/tools/save-profile.js";
import { AdapterRegistry } from "../src/adapters/registry.js";

describe("Gate 1: Core Contract and Storage Verification", () => {
  let tempDir: string;
  let workspaceDir: string;
  let store: ProfileStore;
  let adapterRegistry: AdapterRegistry;
  let previewManager: PreviewManager;

  const validCapabilities: HostCapabilities = {
    host_id: "host-gate1",
    adapter_id: "generic",
    observed_at: new Date().toISOString(),
    available_models: [
      { id: "model-authorized-1", state: "available" },
      { id: "model-authorized-2", state: "available" },
      { id: "model-host-only", state: "available" },
      { id: "model-retired", state: "unavailable" },
    ],
    supported_effort_values: ["low", "medium", "high"],
    capabilities: {
      subagents: { state: "available" },
      threads: { state: "available" },
      parallelism: { state: "available" },
      model_selection: { state: "available" },
    },
  };

  const sampleSingleProfile: Profile = {
    profile_version: 1,
    host: {
      id: "host-gate1",
      adapter: "generic",
    },
    scope: {
      type: "project",
      workspace: "/dummy/workspace",
    },
    model_mode: "single",
    single_model: {
      model: "model-authorized-1",
      execution_effort: { policy: "highest-supported" },
      review_effort: { policy: "highest-supported" },
    },
    capabilities: {
      subagents: "available",
      threads: "available",
      parallelism: "available",
      concurrency: 2,
    },
  };

  const sampleMultiProfile: Profile = {
    profile_version: 1,
    host: {
      id: "host-gate1",
      adapter: "generic",
    },
    scope: {
      type: "project",
      workspace: "/dummy/workspace",
    },
    model_mode: "multi",
    tiers: {
      routine: { model: "model-authorized-1", source: "user-confirmed" },
      standard: { model: "model-authorized-1", source: "user-confirmed" },
      high: { model: "model-authorized-2", source: "user-confirmed" },
      review: { model: "model-authorized-2", source: "user-confirmed" },
    },
    capabilities: {
      subagents: "available",
      threads: "available",
      parallelism: "available",
      concurrency: 2,
    },
  };

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-config-gate1-test-"));
    workspaceDir = path.join(tempDir, "workspace");
    await fsp.mkdir(workspaceDir, { recursive: true });

    store = new ProfileStore({ baseDir: path.join(tempDir, "profiles") });
    adapterRegistry = new AdapterRegistry();
    previewManager = new PreviewManager();
  });

  afterEach(async () => {
    if (fs.existsSync(tempDir)) {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  // ==========================================================================
  // Test A: Profile Identity Isolation
  // ==========================================================================
  describe("Test A: Profile Identity Isolation", () => {
    it("never falls back to adapter.id when host_id is distinct or missing", async () => {
      const distinctHostProfile: Profile = {
        ...sampleSingleProfile,
        host: {
          id: "concrete-host-special",
          adapter: "generic",
        },
        scope: {
          type: "project",
          workspace: workspaceDir,
        },
      };

      await store.saveProfile(distinctHostProfile);

      // Distinct host profile is found
      const foundSpecial = await store.getProfile("concrete-host-special", workspaceDir);
      expect(foundSpecial).not.toBeNull();
      expect(foundSpecial?.host.id).toBe("concrete-host-special");

      // Querying with adapter.id ("generic") must return null; no silent fallback
      const foundAdapter = await store.getProfile("generic", workspaceDir);
      expect(foundAdapter).toBeNull();
    });

    it("handleSaveProfile resolves adapter via host.adapter instead of host.id", async () => {
      const toolContext = {
        profileStore: store,
        adapterRegistry,
        previewManager,
      };

      const result = await handleSaveProfile(
        {
          profile: {
            ...sampleSingleProfile,
            host: {
              id: "unique-workstation-id",
              adapter: "generic",
            },
            scope: {
              type: "project",
              workspace: workspaceDir,
            },
          },
        },
        toolContext
      );

      expect(result.success).toBe(true);
      expect(result.profile.host.id).toBe("unique-workstation-id");
      expect(result.profile.host.adapter).toBe("generic");

      // Saved under unique-workstation-id
      const loaded = await store.getProfile("unique-workstation-id", workspaceDir);
      expect(loaded).not.toBeNull();

      // NOT under generic
      const genericLoaded = await store.getProfile("generic", workspaceDir);
      expect(genericLoaded).toBeNull();
    });
  });

  // ==========================================================================
  // Test B: Global Profile Storage & Explicit Fallback Policy
  // ==========================================================================
  describe("Test B: Global Profile Storage & Explicit Fallback Policy", () => {
    it("stores global profiles directly as global.json and enforces explicit fallback policy", async () => {
      const toolContext = {
        profileStore: store,
        adapterRegistry,
        previewManager,
      };

      // 1. Save global profile via handleSaveProfile
      const saveRes = await handleSaveProfile(
        {
          profile: {
            ...sampleSingleProfile,
            host: {
              id: "host-alpha",
              adapter: "generic",
            },
            scope: {
              type: "global",
              workspace: "global",
            },
          },
        },
        toolContext
      );
      expect(saveRes.success).toBe(true);

      // Check physical path on disk: must be <baseDir>/host-alpha/global.json
      const expectedGlobalPath = store.getProfilePath("host-alpha", "global");
      expect(expectedGlobalPath.endsWith(path.join("host-alpha", "global.json"))).toBe(true);
      expect(fs.existsSync(expectedGlobalPath)).toBe(true);

      // Check that it did NOT resolve to <cwd>/global
      const badPath = path.resolve(process.cwd(), "global");
      expect(fs.existsSync(badPath)).toBe(false);

      // 2. Querying project workspace with default fallback (false) -> returns null
      const projectWorkspace = path.join(workspaceDir, "subproject");
      const defaultLookup = await store.getProfile("host-alpha", projectWorkspace);
      expect(defaultLookup).toBeNull();

      // 3. Querying project workspace with explicit fallbackToGlobal: true -> returns global profile
      const fallbackLookup = await store.getProfile("host-alpha", projectWorkspace, {
        fallbackToGlobal: true,
      });
      expect(fallbackLookup).not.toBeNull();
      expect(fallbackLookup?.host.id).toBe("host-alpha");
      expect(fallbackLookup?.scope.type).toBe("global");

      // 4. Store constructed with fallbackToGlobal: true falls back automatically
      const fallbackStore = new ProfileStore({
        baseDir: store.baseDir,
        fallbackToGlobal: true,
      });
      const autoFallback = await fallbackStore.getProfile("host-alpha", projectWorkspace);
      expect(autoFallback).not.toBeNull();
      expect(autoFallback?.host.id).toBe("host-alpha");

      // 5. Precedence: Project profile > Global profile
      const projectProfile: Profile = {
        ...sampleSingleProfile,
        host: { id: "host-alpha", adapter: "generic" },
        scope: { type: "project", workspace: projectWorkspace },
        single_model: { model: "model-authorized-2" },
      };
      await store.saveProfile(projectProfile);

      const precedenceLookup = await store.getProfile("host-alpha", projectWorkspace, {
        fallbackToGlobal: true,
      });
      expect(precedenceLookup).not.toBeNull();
      expect(precedenceLookup?.scope.type).toBe("project");
      expect(precedenceLookup?.single_model?.model).toBe("model-authorized-2");
    });
  });

  // ==========================================================================
  // Test C: User Resource Authority
  // ==========================================================================
  describe("Test C: User Resource Authority", () => {
    it("rejects host-available model if not explicitly authorized in user profile", () => {
      // Profile authorizes only "model-authorized-1"
      const profile: Profile = {
        ...sampleSingleProfile,
        scope: { type: "project", workspace: workspaceDir },
      };

      // Config selects "model-host-only" which is in validCapabilities, but NOT in profile
      const config: ExecutionConfig = {
        task_shape: "single-pass",
        model_mode: "single",
        readiness: "executable",
        topology: { type: "single-session", concurrency: 1 },
        execution: {
          model: "model-host-only",
          reasoning: { state: "enabled" },
          context: "current-session",
        },
        review: {
          strategy: "self-check",
          model: "model-authorized-1",
          reasoning: { state: "enabled" },
          context: "current-session",
        },
      };

      const result = validateExecutionConfig(config, profile, validCapabilities);
      expect(result.valid).toBe(false);
      expect(result.errors?.[0]).toMatch(/not explicitly authorized in user profile/);
    });

    it("rejects profile grant if model is not evidenced as available on host", () => {
      // Profile claims to authorize "unsupported-model-99"
      const profile: Profile = {
        ...sampleSingleProfile,
        scope: { type: "project", workspace: workspaceDir },
        single_model: {
          model: "unsupported-model-99",
        },
      };

      const config: ExecutionConfig = {
        task_shape: "single-pass",
        model_mode: "single",
        readiness: "executable",
        topology: { type: "single-session", concurrency: 1 },
        execution: {
          model: "unsupported-model-99",
          reasoning: { state: "enabled" },
          context: "current-session",
        },
        review: {
          strategy: "self-check",
          model: "unsupported-model-99",
          reasoning: { state: "enabled" },
          context: "current-session",
        },
      };

      const result = validateExecutionConfig(config, profile, validCapabilities);
      expect(result.valid).toBe(false);
      expect(result.errors?.[0]).toMatch(/not evidenced as available on host/);
      expect(result.errors?.[0]).toMatch(/Profile grant alone does not count as availability evidence/);
    });

    it("passes when models are BOTH authorized by user and evidenced as available on host", () => {
      const profile: Profile = {
        ...sampleSingleProfile,
        scope: { type: "project", workspace: workspaceDir },
      };

      const config: ExecutionConfig = {
        task_shape: "single-pass",
        model_mode: "single",
        readiness: "executable",
        topology: { type: "single-session", concurrency: 1 },
        execution: {
          model: "model-authorized-1",
          reasoning: { state: "enabled" },
          context: "current-session",
        },
        review: {
          strategy: "self-check",
          model: "model-authorized-1",
          reasoning: { state: "enabled" },
          context: "current-session",
        },
      };

      const result = validateExecutionConfig(config, profile, validCapabilities);
      expect(result.valid).toBe(true);
      expect(result.errors).toBeUndefined();
    });
  });

  // ==========================================================================
  // Test D: Unknown Capability Fail-Closed Rejection
  // ==========================================================================
  describe("Test D: Unknown Capability Fail-Closed Rejection", () => {
    it("fails closed when required capability has state 'unknown'", () => {
      const unknownSubagentsCapabilities: HostCapabilities = {
        ...validCapabilities,
        capabilities: {
          ...validCapabilities.capabilities,
          subagents: { state: "unknown" },
        },
      };

      const decomposedConfig: ExecutionConfig = {
        task_shape: "decomposed",
        model_mode: "multi",
        readiness: "executable",
        topology: {
          type: "controller-workers",
          concurrency: 2,
          subagent_contexts: true,
        },
        controller: {
          model: "model-authorized-1",
          reasoning: { state: "enabled" },
          context: "main-session",
        },
        work_items: [
          {
            ticket_id: "01-task",
            difficulty: "routine",
            model: "model-authorized-1",
            reasoning: { state: "enabled" },
            context: "worker-1",
          },
        ],
        review: {
          strategy: "controller-review",
          model: "model-authorized-2",
          reasoning: { state: "enabled" },
          context: "main-session",
        },
      };

      const result = validateExecutionConfig(
        decomposedConfig,
        sampleMultiProfile,
        unknownSubagentsCapabilities
      );

      expect(result.valid).toBe(false);
      expect(result.errors?.some((e) => e.includes("Fail-closed rejection"))).toBe(true);
      expect(result.errors?.some((e) => e.includes("subagents"))).toBe(true);
    });

    it("fails closed when parallelism state is 'unknown' for concurrency > 1", () => {
      const unknownParallelCapabilities: HostCapabilities = {
        ...validCapabilities,
        capabilities: {
          ...validCapabilities.capabilities,
          parallelism: { state: "unknown" },
        },
      };

      const parallelConfig: ExecutionConfig = {
        task_shape: "single-pass",
        model_mode: "single",
        readiness: "executable",
        topology: {
          type: "parallel-workers",
          concurrency: 4,
        },
        execution: {
          model: "model-authorized-1",
          reasoning: { state: "enabled" },
          context: "current-session",
        },
        review: {
          strategy: "self-check",
          model: "model-authorized-1",
          reasoning: { state: "enabled" },
          context: "current-session",
        },
      };

      const result = validateExecutionConfig(
        parallelConfig,
        sampleSingleProfile,
        unknownParallelCapabilities
      );

      expect(result.valid).toBe(false);
      expect(result.errors?.some((e) => e.includes("Fail-closed rejection"))).toBe(true);
      expect(result.errors?.some((e) => e.includes("parallelism"))).toBe(true);
    });
  });

  // ==========================================================================
  // Test E: Multi-Target Transactional Preflight, Compensating Rollback & Non-reversible Rejection
  // ==========================================================================
  describe("Test E: Multi-Target Transactional Preflight & Rollback", () => {
    it("fails preflight before modifying any target if an operation has reversible: false", async () => {
      const targetA = path.join(workspaceDir, "file-a.txt");
      const targetB = path.join(workspaceDir, "file-b.txt");

      const preview: StoredPreview = {
        preview_id: "prev-non-reversible",
        preview_hash: "sha256-dummy",
        adapter_id: "generic",
        host_identity: "generic",
        scope: "project",
        target: targetA,
        baseline_hash: null,
        mutation: { diff: "create files" },
        workspace: workspaceDir,
        config: {},
        diff: "create files",
        mutation_targets: [targetA, targetB],
        target_hashes: { [targetA]: null, [targetB]: null },
        rendered: { preview_id: "prev-non-reversible", mutation_targets: [targetA, targetB], diff: "" },
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 60000).toISOString(),
        applied: false,
        operations: [
          {
            type: "file",
            target: targetA,
            action: "create",
            diff: "create A",
            content: "content A",
            baseline_hash: null,
            reversible: true,
          },
          {
            type: "file",
            target: targetB,
            action: "create",
            diff: "create B",
            content: "content B",
            baseline_hash: null,
            reversible: false, // NON-REVERSIBLE!
          },
        ],
      };

      await expect(
        previewManager.executeTransaction(preview, { requireReversibility: true })
      ).rejects.toThrow(/Preflight failed: Operation targeting '.*' is marked non-reversible/);

      // Preflight fails BEFORE execution: neither file must exist
      expect(fs.existsSync(targetA)).toBe(false);
      expect(fs.existsSync(targetB)).toBe(false);
    });

    it("fails preflight before modifying any target if baseline hash drifts", async () => {
      const targetA = path.join(workspaceDir, "file-drift-a.txt");
      const targetB = path.join(workspaceDir, "file-drift-b.txt");

      await fsp.writeFile(targetB, "initial content B", "utf-8");

      const preview: StoredPreview = {
        preview_id: "prev-drift",
        preview_hash: "sha256-dummy",
        adapter_id: "generic",
        host_identity: "generic",
        scope: "project",
        target: targetA,
        baseline_hash: null,
        mutation: { diff: "create files" },
        workspace: workspaceDir,
        config: {},
        diff: "create files",
        mutation_targets: [targetA, targetB],
        target_hashes: { [targetA]: null, [targetB]: "incorrect-hash" },
        rendered: { preview_id: "prev-drift", mutation_targets: [targetA, targetB], diff: "" },
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 60000).toISOString(),
        applied: false,
        operations: [
          {
            type: "file",
            target: targetA,
            action: "create",
            diff: "create A",
            content: "content A",
            baseline_hash: null, // targetA doesn't exist
            reversible: true,
          },
          {
            type: "file",
            target: targetB,
            action: "update",
            diff: "update B",
            content: "new content B",
            baseline_hash: "sha256-drifted-wrong-hash", // DRIFTED
            reversible: true,
          },
        ],
      };

      await expect(previewManager.executeTransaction(preview)).rejects.toThrow(
        /Baseline drift detected/
      );

      // File A was never created!
      expect(fs.existsSync(targetA)).toBe(false);
      // File B was never modified!
      expect(await fsp.readFile(targetB, "utf-8")).toBe("initial content B");
    });

    it("rolls back prior operations in reverse order if an operation fails mid-transaction", async () => {
      const target1 = path.join(workspaceDir, "step1.txt");
      const target2 = path.join(workspaceDir, "step2.txt");
      const target3 = path.join(workspaceDir, "invalid-dir", "step3.txt");

      await fsp.writeFile(target1, "original 1", "utf-8");
      const hash1 = crypto.createHash("sha256").update("original 1").digest("hex");

      const preview: StoredPreview = {
        preview_id: "prev-rollback",
        preview_hash: "sha256-dummy",
        adapter_id: "generic",
        host_identity: "generic",
        scope: "project",
        target: target1,
        baseline_hash: hash1,
        mutation: { diff: "multi-step" },
        workspace: workspaceDir,
        config: {},
        diff: "multi-step",
        mutation_targets: [target1, target2, target3],
        target_hashes: { [target1]: hash1, [target2]: null, [target3]: null },
        rendered: { preview_id: "prev-rollback", mutation_targets: [target1, target2, target3], diff: "" },
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 60000).toISOString(),
        applied: false,
        operations: [
          {
            type: "file",
            target: target1,
            action: "update",
            diff: "update 1",
            content: "modified 1",
            baseline_hash: hash1,
            reversible: true,
          },
          {
            type: "file",
            target: target2,
            action: "create",
            diff: "create 2",
            content: "created 2",
            baseline_hash: null,
            reversible: true,
          },
          {
            type: "file",
            target: target3,
            action: "create",
            diff: "create 3",
            content: undefined, // Will trigger throw!
            baseline_hash: null,
            reversible: true,
          },
        ],
      };

      try {
        await previewManager.executeTransaction(preview);
        expect.unreachable("Transaction should have failed at step 3");
      } catch (err: any) {
        expect(err.terminalState).toBe("ROLLED_BACK");
        expect(err.message).toMatch(/Transaction failed at operation 2/);
      }

      // Rollback verification: target1 content restored to "original 1"
      expect(await fsp.readFile(target1, "utf-8")).toBe("original 1");
      // target2 created file deleted
      expect(fs.existsSync(target2)).toBe(false);
    });

    it("enters PARTIALLY_APPLIED / REPAIR_REQUIRED if compensating rollback fails", async () => {
      const target1 = path.join(workspaceDir, "repair1.txt");
      const target2 = path.join(workspaceDir, "repair2.txt");

      const preview: StoredPreview = {
        preview_id: "prev-repair",
        preview_hash: "sha256-dummy",
        adapter_id: "generic",
        host_identity: "generic",
        scope: "project",
        target: target1,
        baseline_hash: null,
        mutation: { diff: "fail rollback" },
        workspace: workspaceDir,
        config: {},
        diff: "fail rollback",
        mutation_targets: [target1, target2],
        target_hashes: { [target1]: null, [target2]: null },
        rendered: { preview_id: "prev-repair", mutation_targets: [target1, target2], diff: "" },
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 60000).toISOString(),
        applied: false,
        operations: [
          {
            type: "file",
            target: target1,
            action: "create",
            diff: "create 1",
            content: "content 1",
            baseline_hash: null,
            reversible: true,
          },
          {
            type: "file",
            target: target2,
            action: "create",
            diff: "create 2",
            content: undefined, // Fails
            baseline_hash: null,
            reversible: true,
          },
        ],
      };

      // Mock unlink to fail during rollback
      const originalUnlink = fsp.unlink;
      (fsp as any).unlink = async () => {
        throw new Error("Disk hardware failure during unlink");
      };

      try {
        await previewManager.executeTransaction(preview);
        expect.unreachable("Should have failed");
      } catch (err: any) {
        expect(err.terminalState).toBe("PARTIALLY_APPLIED");
        expect(err.state).toBe("REPAIR_REQUIRED");
        expect(err.message).toMatch(/PARTIALLY_APPLIED \/ REPAIR_REQUIRED/);
      } finally {
        fsp.unlink = originalUnlink;
      }
    });
  });

  // ==========================================================================
  // Test F: Two-Layer Result Architecture & Host-Neutral Reasoning Invariants
  // ==========================================================================
  describe("Test F: Two-Layer Result Architecture & Host-Neutral Reasoning Invariants", () => {
    it("enforces invariant: execution_config exists if and only if readiness is 'READY'", () => {
      const validConfig: ExecutionConfig = {
        task_shape: "single-pass",
        model_mode: "single",
        readiness: "executable",
        topology: { type: "single-session", concurrency: 1 },
        execution: {
          model: "m1",
          reasoning: { state: "enabled" },
          context: "main",
        },
        review: {
          strategy: "self-check",
          model: "m1",
          reasoning: { state: "enabled" },
          context: "main",
        },
      };

      // READY with execution_config -> OK
      const readyResult = createAgentConfigResult({
        readiness: "READY",
        mode: "persisted",
        setup_state: { companion: "ready", profile: "persisted" },
        handoff: "implement",
        execution_config: validConfig,
      });
      expect(readyResult.readiness).toBe("READY");
      expect(readyResult.execution_config).not.toBeNull();
      expect(AgentConfigResultSchema.safeParse(readyResult).success).toBe(true);

      // READY with null execution_config -> Invariant violation!
      expect(() =>
        createAgentConfigResult({
          readiness: "READY",
          mode: "persisted",
          setup_state: { companion: "ready", profile: "persisted" },
          handoff: "implement",
          execution_config: null,
        })
      ).toThrow(/execution_config must not be null when readiness is 'READY'/);

      // Non-READY (e.g. BLOCKED) with non-null execution_config -> Invariant violation!
      expect(() =>
        createAgentConfigResult({
          readiness: "BLOCKED",
          mode: "plan-only",
          setup_state: { companion: "missing", profile: "missing" },
          handoff: "setup",
          execution_config: validConfig,
        })
      ).toThrow(/execution_config must be null when readiness is 'BLOCKED'/);

      // Non-READY with null execution_config -> OK
      const blockedResult = createAgentConfigResult({
        readiness: "BLOCKED",
        mode: "plan-only",
        setup_state: { companion: "missing", profile: "missing" },
        handoff: "setup",
        execution_config: null,
        reason: "Companion missing",
      });
      expect(blockedResult.execution_config).toBeNull();
      expect(AgentConfigResultSchema.safeParse(blockedResult).success).toBe(true);
    });

    it("migrates legacy effort into canonical reasoning object and removes legacy effort fields", () => {
      const legacyRaw = {
        task_shape: "single-pass",
        model_mode: "single",
        readiness: "executable",
        topology: { type: "single-session", concurrency: 1 },
        execution: {
          model: "o3-mini",
          effort: "high",
          effort_policy: "highest-supported",
          context: "current-session",
        },
        review: {
          strategy: "self-check",
          model: "o3-mini",
          effort: "medium",
          context: "current-session",
        },
      };

      const parsed = ExecutionConfigSchema.parse(legacyRaw);

      // Canonical reasoning object is present
      expect(parsed.execution?.reasoning).toEqual({
        state: "enabled",
        policy: "highest-supported",
        resolved: {
          host_field: "effort",
          host_value: "high",
        },
      });

      expect(parsed.review.reasoning).toEqual({
        state: "enabled",
        resolved: {
          host_field: "effort",
          host_value: "medium",
        },
      });

      // Legacy string effort fields are stripped from canonical output
      expect((parsed.execution as any)?.effort).toBeUndefined();
      expect((parsed.execution as any)?.effort_policy).toBeUndefined();
      expect((parsed.review as any)?.effort).toBeUndefined();
    });
  });
});
