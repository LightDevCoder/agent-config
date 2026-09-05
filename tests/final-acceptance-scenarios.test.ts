import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import {
  ProfileStore,
  Profile,
  ExecutionConfig,
  AgentConfigResult,
  createAgentConfigResult,
  AgentConfigResultSchema,
  validateExecutionConfig,
  evaluateCompanionHealth,
  CANONICAL_TOOL_CONTRACTS,
  TOOL_NAMES,
  PROTOCOL_VERSION,
  HostCapabilities,
  AdapterRegistry,
  DshAdapter,
  PreviewManager,
  StoredPreview,
  handleSaveProfile,
  inspectCompanionSetup,
  GenericAdapter,
} from "../src/index.js";

/**
 * Deterministic model of implement's routing evaluation and execution dispatch
 * mirroring skills/implement/tests/test_implement_behavior.py.
 */
class ImplementDecisionEngine {
  static evaluateRoutingNeed(task: {
    change_units?: string[];
    files?: string[];
    requires_role_split?: boolean;
    requires_reviewer_isolation?: boolean;
    is_solo_bounded?: boolean;
    ticket?: string;
    requires_ticket_decomposition?: boolean;
  }): boolean {
    const unitsCount = task.change_units?.length ?? 0;
    const filesCount = task.files?.length ?? 0;
    const requiresRoleSplit = Boolean(task.requires_role_split);
    const requiresReviewerIsolation = Boolean(task.requires_reviewer_isolation);
    const isSolo = Boolean(task.is_solo_bounded);

    if (isSolo && unitsCount <= 1 && filesCount <= 2 && !requiresReviewerIsolation) {
      return false;
    }
    return (
      unitsCount > 1 ||
      filesCount > 3 ||
      requiresRoleSplit ||
      requiresReviewerIsolation ||
      Boolean(task.ticket) ||
      Boolean(task.requires_ticket_decomposition)
    );
  }

  static consumeAgentConfigResult(
    result: AgentConfigResult,
    userSetupResponse?: "accept" | "decline"
  ): {
    action: string;
    execution_config?: ExecutionConfig | null;
    handoff?: string | null;
    halted?: boolean;
    reason?: string;
    diagnostics?: string[];
    profile_state?: string;
  } {
    const { readiness } = result;

    if (readiness === "READY") {
      if (!result.execution_config) {
        return {
          action: "BLOCKED",
          halted: true,
          reason: "invariant violation: execution_config must not be null when readiness is READY",
        };
      }
      return {
        action: "execute_with_agent_config",
        execution_config: result.execution_config,
        handoff: result.handoff,
        reason: "consumed execution_config and executing bounded slice",
      };
    }

    if (readiness === "NEED_INPUT") {
      const profileState = result.setup_state?.profile;
      if (userSetupResponse === "decline") {
        return {
          action: "execute_direct",
          reason: "user declined setup; fallback safely to direct single-agent execution",
        };
      }
      if (userSetupResponse === "accept") {
        return {
          action: "handoff_to_setup",
          handoff: "setup",
          reason: "user accepted setup; handing off to setup",
        };
      }
      return {
        action: "offer_setup",
        handoff: result.handoff,
        profile_state: profileState,
        reason: "profile missing or setup needed; offer setup or fallback",
      };
    }

    if (readiness === "NEED_PROJECT_TICKETS") {
      return {
        action: "handoff_to_project_tickets",
        handoff: "project-tickets",
        halted: true,
        reason: "decomposed task without tickets requires formal tickets; halting implementation",
      };
    }

    if (readiness === "BLOCKED" || readiness === "UNSUPPORTED") {
      return {
        action: readiness,
        halted: true,
        reason: result.reason || `core rejection: ${readiness}`,
        diagnostics: result.diagnostics,
      };
    }

    return {
      action: "BLOCKED",
      halted: true,
      reason: `unknown readiness state: ${readiness}`,
    };
  }

  static decideAction(
    task: any,
    options?: {
      userIntent?: string;
      userChoiceResponse?: "accept" | "decline";
      agentConfigResult?: AgentConfigResult;
      userSetupResponse?: "accept" | "decline";
    }
  ) {
    const { userIntent, userChoiceResponse, agentConfigResult, userSetupResponse } = options || {};

    if (userIntent === "explicit_enable") {
      if (agentConfigResult) {
        const consumption = this.consumeAgentConfigResult(agentConfigResult, userSetupResponse);
        return {
          ...consumption,
          offered_agent_config: false,
          invoked_agent_config: true,
        };
      }
      return {
        action: "execute_with_agent_config",
        offered_agent_config: false,
        invoked_agent_config: true,
        reason: "explicit user request to use routing",
      };
    }

    if (userIntent === "explicit_disable") {
      return {
        action: "execute_direct",
        offered_agent_config: false,
        invoked_agent_config: false,
        reason: "explicit user request to skip routing",
      };
    }

    const materiallyHelpful = this.evaluateRoutingNeed(task);
    if (!materiallyHelpful) {
      return {
        action: "execute_direct",
        offered_agent_config: false,
        invoked_agent_config: false,
        reason: "bounded solo task does not require routing offer",
      };
    }

    if (userChoiceResponse === undefined) {
      return {
        action: "await_user_choice",
        offered_agent_config: true,
        invoked_agent_config: false,
        reason: "offering agent-config for user opt-in",
      };
    }

    if (userChoiceResponse === "accept") {
      if (agentConfigResult) {
        const consumption = this.consumeAgentConfigResult(agentConfigResult, userSetupResponse);
        return {
          ...consumption,
          offered_agent_config: true,
          invoked_agent_config: true,
        };
      }
      return {
        action: "execute_with_agent_config",
        offered_agent_config: true,
        invoked_agent_config: true,
        reason: "user accepted agent-config routing",
      };
    }

    if (userChoiceResponse === "decline") {
      return {
        action: "execute_direct",
        offered_agent_config: true,
        invoked_agent_config: false,
        reason: "user declined agent-config routing; direct execution proceeds",
      };
    }

    return {
      action: "execute_direct",
      offered_agent_config: true,
      invoked_agent_config: false,
      reason: "fallback to direct execution",
    };
  }
}

describe("Final Acceptance Scenarios (SPEC Verification §1 - §8)", () => {
  let tempDir: string;
  let workspaceDir: string;
  let userHomeDir: string;
  let originalHome: string | undefined;
  let originalEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-config-final-scenarios-"));
    workspaceDir = path.join(tempDir, "workspace");
    userHomeDir = path.join(tempDir, "home");
    await fsp.mkdir(workspaceDir, { recursive: true });
    await fsp.mkdir(userHomeDir, { recursive: true });

    originalHome = process.env.HOME;
    originalEnv = {
      DSH_RUNTIME: process.env.DSH_RUNTIME,
      DEEPSEEK_HARNESS: process.env.DEEPSEEK_HARNESS,
      CORDIS_APP: process.env.CORDIS_APP,
      DSH_HOME: process.env.DSH_HOME,
      DSH_PROFILE: process.env.DSH_PROFILE,
      DSH_PRESET: process.env.DSH_PRESET,
      DSH_VERSION: process.env.DSH_VERSION,
    };

    process.env.HOME = userHomeDir;
    delete process.env.DSH_RUNTIME;
    delete process.env.DEEPSEEK_HARNESS;
    delete process.env.CORDIS_APP;
    delete process.env.DSH_HOME;
    delete process.env.DSH_PROFILE;
    delete process.env.DSH_PRESET;
    delete process.env.DSH_VERSION;
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

  // ==========================================================================
  // Scenario 1: Fresh workspace detection & profile creation without silent mutation
  // ==========================================================================
  describe("Scenario 1: Fresh Workspace Detection & Profile Creation Without Silent Mutation", () => {
    it("leaves workspace completely unmutated across inspection, profile store operations, and preview creation until approved preview is applied", async () => {
      const adapterRegistry = new AdapterRegistry();
      const previewManager = new PreviewManager();
      const store = new ProfileStore(path.join(tempDir, "profiles"));

      // 1. Initial assertion: workspace is clean and empty
      const initialEntries = await fsp.readdir(workspaceDir);
      expect(initialEntries).toHaveLength(0);

      // 2. Host identification and capabilities inspection against fresh workspace
      const resolvedAdapter = await adapterRegistry.resolveAdapter(workspaceDir);
      expect(resolvedAdapter).toBeDefined();

      const genericAdapter = adapterRegistry.getAdapter("generic");
      expect(genericAdapter).toBeDefined();
      const caps = await genericAdapter!.inspectCapabilities(workspaceDir);
      expect(caps).toBeDefined();

      const setupInspect = await inspectCompanionSetup(workspaceDir, "generic");
      expect(setupInspect.registered).toBe(false);

      // Verify workspace remains completely untouched after inspection
      const postInspectEntries = await fsp.readdir(workspaceDir);
      expect(postInspectEntries).toHaveLength(0);

      // 3. ProfileStore operations: querying and saving profiles
      const loaded = await store.getProfile("generic", workspaceDir);
      expect(loaded).toBeNull();

      // Create and save a global profile
      const globalProfile: Profile = {
        profile_version: 1,
        host: { id: "generic", adapter: "generic" },
        scope: { type: "global", workspace: "global" },
        model_mode: "single",
        single_model: {
          model: "claude-sonnet-4",
          execution_effort: { policy: "highest-supported" },
        },
      };

      await store.saveProfile(globalProfile);

      // Verify workspace is STILL completely untouched
      const postSaveEntries = await fsp.readdir(workspaceDir);
      expect(postSaveEntries).toHaveLength(0);

      // 4. Preview creation: generating preview must NOT mutate workspace
      const targetFile = path.join(workspaceDir, "test-config.json");
      const preview = await previewManager.createPreview(
        workspaceDir,
        {
          preview_id: "preview-scenario-1",
          mutation_targets: [targetFile],
          diff: "create test-config.json",
          files: [{ path: targetFile, content: '{"model":"claude-sonnet-4"}' }],
        },
        { model: "claude-sonnet-4" },
        {
          adapter_id: "generic",
          host_identity: "generic",
          scope: "project",
          target: targetFile,
        }
      );

      const retrieved = previewManager.getPreview(preview.preview_id);
      expect(retrieved).toBeDefined();

      // Verify workspace is STILL completely unmutated before apply
      expect(fs.existsSync(targetFile)).toBe(false);
      expect(await fsp.readdir(workspaceDir)).toHaveLength(0);

      // 5. Approved preview is applied: ONLY NOW does workspace mutate
      const applyResult = await previewManager.executeTransaction(preview);
      expect(applyResult.success).toBe(true);
      expect(applyResult.state).toBe("SUCCESS");

      // Verify target file was created with exact content
      expect(fs.existsSync(targetFile)).toBe(true);
      const content = await fsp.readFile(targetFile, "utf-8");
      expect(content).toBe('{"model":"claude-sonnet-4"}');
    });
  });

  // ==========================================================================
  // Scenario 2: Two-gate authorization
  // ==========================================================================
  describe("Scenario 2: Two-Gate Authorization & Unknown Capability Fail-Closed Rejection", () => {
    const hostCapabilities: HostCapabilities = {
      host_id: "host-scenario-2",
      adapter_id: "generic",
      observed_at: new Date().toISOString(),
      available_models: [
        { id: "model-sonnet", state: "available" },
        { id: "model-opus", state: "available" },
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

    const userProfile: Profile = {
      profile_version: 1,
      host: { id: "host-scenario-2", adapter: "generic" },
      scope: { type: "project", workspace: "/dummy" },
      model_mode: "single",
      single_model: {
        model: "model-sonnet",
        execution_effort: { policy: "highest-supported" },
      },
    };

    it("rejects model if available on host but unauthorized in user profile (Gate 1)", () => {
      // "model-opus" is available on host, but userProfile authorizes only "model-sonnet"
      const config: ExecutionConfig = {
        task_shape: "single-pass",
        model_mode: "single",
        readiness: "executable",
        topology: { type: "single-session", concurrency: 1 },
        execution: {
          model: "model-opus",
          reasoning: { state: "enabled" },
          context: "current-session",
        },
        review: {
          strategy: "self-check",
          model: "model-sonnet",
          reasoning: { state: "enabled" },
          context: "current-session",
        },
      };

      const result = validateExecutionConfig(config, userProfile, hostCapabilities);
      expect(result.valid).toBe(false);
      expect(result.errors?.[0]).toMatch(/not explicitly authorized in user profile/);
    });

    it("rejects profile grant if model is not evidenced as available on host (Gate 2)", () => {
      // Profile claims to authorize "model-retired" or "model-phantom"
      const phantomProfile: Profile = {
        ...userProfile,
        single_model: { model: "model-retired" },
      };

      const config: ExecutionConfig = {
        task_shape: "single-pass",
        model_mode: "single",
        readiness: "executable",
        topology: { type: "single-session", concurrency: 1 },
        execution: {
          model: "model-retired",
          reasoning: { state: "enabled" },
          context: "current-session",
        },
        review: {
          strategy: "self-check",
          model: "model-retired",
          reasoning: { state: "enabled" },
          context: "current-session",
        },
      };

      const result = validateExecutionConfig(config, phantomProfile, hostCapabilities);
      expect(result.valid).toBe(false);
      expect(result.errors?.[0]).toMatch(/not evidenced as available on host/);
      expect(result.errors?.[0]).toMatch(/Profile grant alone does not count as availability evidence/);
    });

    it("passes when selected model satisfies both Gate 1 (profile authorized) and Gate 2 (host evidenced)", () => {
      const config: ExecutionConfig = {
        task_shape: "single-pass",
        model_mode: "single",
        readiness: "executable",
        topology: { type: "single-session", concurrency: 1 },
        execution: {
          model: "model-sonnet",
          reasoning: { state: "enabled" },
          context: "current-session",
        },
        review: {
          strategy: "self-check",
          model: "model-sonnet",
          reasoning: { state: "enabled" },
          context: "current-session",
        },
      };

      const result = validateExecutionConfig(config, userProfile, hostCapabilities);
      expect(result.valid).toBe(true);
      expect(result.errors).toBeUndefined();
    });

    it("fails closed when required capability has state 'unknown'", () => {
      const unknownCapabilityCaps: HostCapabilities = {
        ...hostCapabilities,
        capabilities: {
          ...hostCapabilities.capabilities,
          subagents: { state: "unknown" },
        },
      };

      const decomposedConfig: ExecutionConfig = {
        task_shape: "decomposed",
        model_mode: "single",
        readiness: "executable",
        topology: {
          type: "controller-workers",
          concurrency: 2,
          subagent_contexts: true,
        },
        controller: {
          model: "model-sonnet",
          reasoning: { state: "enabled" },
          context: "main-session",
        },
        work_items: [
          {
            ticket_id: "01-task",
            model: "model-sonnet",
            reasoning: { state: "enabled" },
            context: "worker-1",
          },
        ],
        review: {
          strategy: "controller-review",
          model: "model-sonnet",
          reasoning: { state: "enabled" },
          context: "main-session",
        },
      };

      const result = validateExecutionConfig(decomposedConfig, userProfile, unknownCapabilityCaps);
      expect(result.valid).toBe(false);
      expect(result.errors?.some((e) => e.includes("Fail-closed rejection"))).toBe(true);
      expect(result.errors?.some((e) => e.includes("subagents"))).toBe(true);
    });
  });

  // ==========================================================================
  // Scenario 3: Transactional multi-target preview & compensating rollback
  // ==========================================================================
  describe("Scenario 3: Transactional Multi-Target Preview, Compensating Rollback & Non-Reversible Preflight Rejection", () => {
    let previewManager: PreviewManager;

    beforeEach(() => {
      previewManager = new PreviewManager();
    });

    it("fails preflight before modifying any target when an operation has reversible: false", async () => {
      const targetA = path.join(workspaceDir, "safe-a.txt");
      const targetB = path.join(workspaceDir, "non-reversible-b.txt");

      const preview: StoredPreview = {
        preview_id: "prev-non-rev",
        preview_hash: "hash-01",
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
        rendered: { preview_id: "prev-non-rev", mutation_targets: [targetA, targetB], diff: "" },
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 60000).toISOString(),
        applied: false,
        operations: [
          {
            type: "file",
            target: targetA,
            action: "create",
            diff: "create safe-a",
            content: "content safe",
            baseline_hash: null,
            reversible: true,
          },
          {
            type: "file",
            target: targetB,
            action: "create",
            diff: "create non-reversible",
            content: "content non-rev",
            baseline_hash: null,
            reversible: false, // NON-REVERSIBLE
          },
        ],
      };

      await expect(
        previewManager.executeTransaction(preview, { requireReversibility: true })
      ).rejects.toThrow(/Preflight failed: Operation targeting '.*' is marked non-reversible/);

      // Preflight fails BEFORE execution: neither file was written to disk
      expect(fs.existsSync(targetA)).toBe(false);
      expect(fs.existsSync(targetB)).toBe(false);
    });

    it("fails preflight before modifying any target if baseline hash drifts", async () => {
      const targetA = path.join(workspaceDir, "create-a.txt");
      const targetB = path.join(workspaceDir, "existing-b.txt");

      await fsp.writeFile(targetB, "current disk content", "utf-8");

      const preview: StoredPreview = {
        preview_id: "prev-drift",
        preview_hash: "hash-02",
        adapter_id: "generic",
        host_identity: "generic",
        scope: "project",
        target: targetA,
        baseline_hash: null,
        mutation: { diff: "update" },
        workspace: workspaceDir,
        config: {},
        diff: "update",
        mutation_targets: [targetA, targetB],
        target_hashes: { [targetA]: null, [targetB]: "stale-baseline-hash" },
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
            baseline_hash: null,
            reversible: true,
          },
          {
            type: "file",
            target: targetB,
            action: "update",
            diff: "update B",
            content: "new content B",
            baseline_hash: "stale-baseline-hash", // DRIFTED
            reversible: true,
          },
        ],
      };

      await expect(previewManager.executeTransaction(preview)).rejects.toThrow(
        /Baseline drift detected/
      );

      // Target A was never created; Target B was never modified
      expect(fs.existsSync(targetA)).toBe(false);
      expect(await fsp.readFile(targetB, "utf-8")).toBe("current disk content");
    });

    it("rolls back prior operations in reverse order if an operation fails mid-transaction", async () => {
      const target1 = path.join(workspaceDir, "op1-update.txt");
      const target2 = path.join(workspaceDir, "op2-create.txt");
      const target3 = path.join(workspaceDir, "op3-fail.txt");

      await fsp.writeFile(target1, "initial-target-1", "utf-8");
      const hash1 = crypto.createHash("sha256").update("initial-target-1").digest("hex");

      const preview: StoredPreview = {
        preview_id: "prev-mid-failure",
        preview_hash: "hash-03",
        adapter_id: "generic",
        host_identity: "generic",
        scope: "project",
        target: target1,
        baseline_hash: hash1,
        mutation: { diff: "3-step" },
        workspace: workspaceDir,
        config: {},
        diff: "3-step",
        mutation_targets: [target1, target2, target3],
        target_hashes: { [target1]: hash1, [target2]: null, [target3]: null },
        rendered: { preview_id: "prev-mid-failure", mutation_targets: [target1, target2, target3], diff: "" },
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 60000).toISOString(),
        applied: false,
        operations: [
          {
            type: "file",
            target: target1,
            action: "update",
            diff: "update 1",
            content: "modified-1",
            baseline_hash: hash1,
            reversible: true,
          },
          {
            type: "file",
            target: target2,
            action: "create",
            diff: "create 2",
            content: "created-2",
            baseline_hash: null,
            reversible: true,
          },
          {
            type: "file",
            target: target3,
            action: "create",
            diff: "create 3",
            content: undefined, // Missing content forces failure
            baseline_hash: null,
            reversible: true,
          },
        ],
      };

      try {
        await previewManager.executeTransaction(preview);
        expect.unreachable("Transaction should have failed at op 3");
      } catch (err: any) {
        expect(err.terminalState).toBe("ROLLED_BACK");
        expect(err.message).toMatch(/Transaction failed at operation 2/);
      }

      // Rollback verification: target1 content restored to initial, target2 deleted
      expect(await fsp.readFile(target1, "utf-8")).toBe("initial-target-1");
      expect(fs.existsSync(target2)).toBe(false);
      expect(fs.existsSync(target3)).toBe(false);
    });

    it("enters PARTIALLY_APPLIED / REPAIR_REQUIRED when compensating rollback itself encounters an error", async () => {
      const target1 = path.join(workspaceDir, "file-corrupted.txt");
      const target2 = path.join(workspaceDir, "file-fail.txt");

      await fsp.writeFile(target1, "original-data", "utf-8");
      const hash1 = crypto.createHash("sha256").update("original-data").digest("hex");

      const preview: StoredPreview = {
        preview_id: "prev-repair-req",
        preview_hash: "hash-04",
        adapter_id: "generic",
        host_identity: "generic",
        scope: "project",
        target: target1,
        baseline_hash: hash1,
        mutation: { diff: "repair req" },
        workspace: workspaceDir,
        config: {},
        diff: "repair req",
        mutation_targets: [target1, target2],
        target_hashes: { [target1]: hash1, [target2]: null },
        rendered: { preview_id: "prev-repair-req", mutation_targets: [target1, target2], diff: "" },
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 60000).toISOString(),
        applied: false,
        operations: [
          {
            type: "file",
            target: target1,
            action: "update",
            diff: "update 1",
            content: "updated-data",
            baseline_hash: hash1,
            reversible: true,
          },
          {
            type: "file",
            target: target2,
            action: "create",
            diff: "create 2",
            content: undefined, // Forces execution failure
            baseline_hash: null,
            reversible: true,
          },
        ],
      };

      // Mock writeFile on rollback to fail restoring target1
      const originalWriteFile = fsp.writeFile;
      let writeCount = 0;
      fsp.writeFile = async (...args: any[]) => {
        writeCount++;
        if (writeCount === 2) {
          // This is the compensating rollback write attempt
          throw new Error("Disk hardware write error during rollback");
        }
        return (originalWriteFile as any)(...args);
      };

      try {
        await previewManager.executeTransaction(preview);
        expect.unreachable("Should have failed");
      } catch (err: any) {
        expect(err.terminalState).toBe("PARTIALLY_APPLIED");
        expect(err.state).toBe("REPAIR_REQUIRED");
        expect(err.message).toMatch(/PARTIALLY_APPLIED \/ REPAIR_REQUIRED/);
        expect(err.diagnostics?.some((d: string) => d.includes("Compensating rollback failed"))).toBe(true);
      } finally {
        fsp.writeFile = originalWriteFile;
      }
    });
  });

  // ==========================================================================
  // Scenario 4: Cross-repo call chain from implement through agent-config
  // ==========================================================================
  describe("Scenario 4: Cross-Repo Call Chain (implement <-> agent-config)", () => {
    it("bypasses agent-config routing offer for solo bounded tasks", () => {
      const soloTask = {
        name: "fix typo in comment",
        files: ["utils.ts"],
        change_units: ["typo"],
        is_solo_bounded: true,
      };

      const decision = ImplementDecisionEngine.decideAction(soloTask);
      expect(decision.action).toBe("execute_direct");
      expect(decision.offered_agent_config).toBe(false);
      expect(decision.invoked_agent_config).toBe(false);
    });

    it("offers routing for ticketed task and consumes execution_config when READY", () => {
      const ticketTask = {
        name: "implement user session token",
        files: ["auth.ts", "token.ts", "session.ts", "test_auth.ts"],
        change_units: ["token", "session"],
        ticket: ".scratch/issues/01-session-token.md",
      };

      // 1. Evaluate routing need
      const offerDecision = ImplementDecisionEngine.decideAction(ticketTask);
      expect(offerDecision.action).toBe("await_user_choice");
      expect(offerDecision.offered_agent_config).toBe(true);

      // 2. User accepts and agent-config returns READY
      const execConfig: ExecutionConfig = {
        task_shape: "single-pass",
        model_mode: "single",
        readiness: "executable",
        topology: { type: "single-session", concurrency: 1 },
        execution: {
          model: "claude-sonnet-4",
          reasoning: {
            state: "enabled",
            policy: "highest-supported",
            resolved: { host_field: "effort", host_value: "high" },
          },
          context: "current-session",
        },
        review: {
          strategy: "self-check",
          model: "claude-sonnet-4",
          context: "current-session",
        },
      };

      const readyResult = createAgentConfigResult({
        readiness: "READY",
        mode: "persisted",
        setup_state: { companion: "ready", profile: "persisted" },
        handoff: "implement",
        execution_config: execConfig,
        reason: "Execution planned and ready",
      });

      const consumeDecision = ImplementDecisionEngine.decideAction(ticketTask, {
        userChoiceResponse: "accept",
        agentConfigResult: readyResult,
      });

      expect(consumeDecision.action).toBe("execute_with_agent_config");
      expect(consumeDecision.execution_config).toBeDefined();
      expect(consumeDecision.execution_config?.execution.model).toBe("claude-sonnet-4");
      expect(consumeDecision.execution_config?.execution.reasoning?.resolved.host_value).toBe("high");
    });

    it("halts with invariant violation if readiness is READY but execution_config is null", () => {
      const readyWithNullConfig: any = {
        readiness: "READY",
        mode: "persisted",
        setup_state: { companion: "ready", profile: "persisted" },
        handoff: "implement",
        execution_config: null,
      };

      const decision = ImplementDecisionEngine.consumeAgentConfigResult(readyWithNullConfig);
      expect(decision.action).toBe("BLOCKED");
      expect(decision.halted).toBe(true);
      expect(decision.reason).toMatch(/invariant violation.*execution_config must not be null/);
    });

    it("offers setup when readiness is NEED_INPUT and profile is missing", () => {
      const needInputResult = createAgentConfigResult({
        readiness: "NEED_INPUT",
        mode: "session-local",
        setup_state: { companion: "ready", profile: "missing" },
        handoff: "setup",
        execution_config: null,
        reason: "Profile missing; setup required",
      });

      // Default prompt
      const offerDecision = ImplementDecisionEngine.consumeAgentConfigResult(needInputResult);
      expect(offerDecision.action).toBe("offer_setup");
      expect(offerDecision.handoff).toBe("setup");
      expect(offerDecision.profile_state).toBe("missing");

      // User accepts setup -> hands off to setup
      const acceptDecision = ImplementDecisionEngine.consumeAgentConfigResult(needInputResult, "accept");
      expect(acceptDecision.action).toBe("handoff_to_setup");
      expect(acceptDecision.handoff).toBe("setup");

      // User declines setup -> safe direct execution fallback
      const declineDecision = ImplementDecisionEngine.consumeAgentConfigResult(needInputResult, "decline");
      expect(declineDecision.action).toBe("execute_direct");
    });

    it("hands off to project-tickets and halts when decomposed task lacks tickets", () => {
      const needTicketsResult = createAgentConfigResult({
        readiness: "NEED_PROJECT_TICKETS",
        mode: "persisted",
        setup_state: { companion: "ready", profile: "persisted" },
        handoff: "project-tickets",
        execution_config: null,
        reason: "Decomposed task requires tickets",
      });

      const decision = ImplementDecisionEngine.consumeAgentConfigResult(needTicketsResult);
      expect(decision.action).toBe("handoff_to_project_tickets");
      expect(decision.handoff).toBe("project-tickets");
      expect(decision.halted).toBe(true);
    });

    it("halts with BLOCKED or UNSUPPORTED on validation or capability rejection", () => {
      const blockedResult = createAgentConfigResult({
        readiness: "BLOCKED",
        mode: "persisted",
        setup_state: { companion: "ready", profile: "persisted" },
        handoff: null,
        execution_config: null,
        reason: "Model unauthorized",
        diagnostics: ["model unauthorized in profile"],
      });

      const blockedDecision = ImplementDecisionEngine.consumeAgentConfigResult(blockedResult);
      expect(blockedDecision.action).toBe("BLOCKED");
      expect(blockedDecision.halted).toBe(true);
      expect(blockedDecision.reason).toBe("Model unauthorized");

      const unsupportedResult = createAgentConfigResult({
        readiness: "UNSUPPORTED",
        mode: "persisted",
        setup_state: { companion: "ready", profile: "persisted" },
        handoff: null,
        execution_config: null,
        reason: "Host lacks subagents capability",
        diagnostics: ["subagents: false"],
      });

      const unsupportedDecision = ImplementDecisionEngine.consumeAgentConfigResult(unsupportedResult);
      expect(unsupportedDecision.action).toBe("UNSUPPORTED");
      expect(unsupportedDecision.halted).toBe(true);
      expect(unsupportedDecision.reason).toBe("Host lacks subagents capability");
    });
  });

  // ==========================================================================
  // Scenario 5: DSH profile patch vs home patch scope separation
  // ==========================================================================
  describe("Scenario 5: DSH Profile Patch vs Home Patch Scope Separation Without Phantom Workspace Patch", () => {
    let dshHome: string;

    beforeEach(async () => {
      dshHome = path.join(tempDir, "dsh-home");
      process.env.DSH_HOME = dshHome;
      process.env.DSH_VERSION = "1.0.0";
      await fsp.mkdir(dshHome, { recursive: true });
    });

    it("targets $DSH_HOME/profiles/<name>/cordis.patch.yml when DSH_PROFILE is set and leaves workspace untouched", async () => {
      const adapter = new DshAdapter();
      process.env.DSH_PROFILE = "analytics-worker";

      const targetConfig = adapter.determineTargetConfigPath(workspaceDir, "global");
      const expectedTarget = path.join(dshHome, "profiles", "analytics-worker", "cordis.patch.yml");
      expect(targetConfig).toBe(expectedTarget);

      // Preview companion registration targeting profile patch
      const preview = await adapter.previewCompanionRegistration(workspaceDir, "global");
      expect(preview.supported).toBe(true);
      expect(preview.target_file).toBe(expectedTarget);
      expect(preview.diff).toContain("@deepseek-ai/dsh-mcp-client");

      // Apply companion registration
      const applyResult = await adapter.applyCompanionRegistration(preview.preview_hash!, workspaceDir, preview);
      expect(applyResult.success).toBe(true);

      // Verify the profile patch was written
      expect(fs.existsSync(expectedTarget)).toBe(true);
      const content = await fsp.readFile(expectedTarget, "utf-8");
      expect(content).toContain("@deepseek-ai/dsh-mcp-client");

      // CRUCIAL: Verify NO phantom workspace patch file was created in workspace
      expect(fs.existsSync(path.join(workspaceDir, "cordis.patch.yml"))).toBe(false);
      expect(fs.existsSync(path.join(workspaceDir, "cordis.patch.yaml"))).toBe(false);
      expect(await fsp.readdir(workspaceDir)).toHaveLength(0);
    });

    it("targets $DSH_HOME/cordis.patch.yml when DSH_PROFILE is unset and leaves workspace untouched", async () => {
      const adapter = new DshAdapter();
      delete process.env.DSH_PROFILE;
      delete process.env.DSH_PRESET;

      const targetConfig = adapter.determineTargetConfigPath(workspaceDir, "global");
      const expectedTarget = path.join(dshHome, "cordis.patch.yml");
      expect(targetConfig).toBe(expectedTarget);

      // Preview companion registration targeting home patch
      const preview = await adapter.previewCompanionRegistration(workspaceDir, "global");
      expect(preview.supported).toBe(true);
      expect(preview.target_file).toBe(expectedTarget);

      // Apply companion registration
      const applyResult = await adapter.applyCompanionRegistration(preview.preview_hash!, workspaceDir, preview);
      expect(applyResult.success).toBe(true);

      // Verify home patch was written
      expect(fs.existsSync(expectedTarget)).toBe(true);
      const content = await fsp.readFile(expectedTarget, "utf-8");
      expect(content).toContain("@deepseek-ai/dsh-mcp-client");

      // Verify NO phantom workspace patch file was created
      expect(fs.existsSync(path.join(workspaceDir, "cordis.patch.yml"))).toBe(false);
      expect(await fsp.readdir(workspaceDir)).toHaveLength(0);
    });

    it("does not imply persistent workspace mutation when Agent Config project profile exists", async () => {
      const adapter = new DshAdapter();

      // Explicit workspace overlay recognized only if manually present
      const overlayPath = path.join(workspaceDir, "cordis.patch.yml");
      expect(fs.existsSync(overlayPath)).toBe(false);

      // Before any explicit overlay exists, project scope does not create one
      const resolved = adapter.determineTargetConfigPath(workspaceDir, "project");
      expect(fs.existsSync(resolved)).toBe(false);

      // If user explicitly created a project overlay, DSH recognizes it as overlay
      await fsp.writeFile(overlayPath, "# explicit project overlay\n", "utf-8");
      const targetWithOverlay = adapter.determineTargetConfigPath(workspaceDir, "project");
      expect(targetWithOverlay).toBe(overlayPath);
    });
  });

  // ==========================================================================
  // Scenario 6: Strict companion health validation
  // ==========================================================================
  describe("Scenario 6: Strict Companion Health Validation", () => {
    // Construct fully compliant canonical tools map matching CANONICAL_TOOL_CONTRACTS
    const canonicalTools: Record<string, any> = {};
    for (const toolName of TOOL_NAMES) {
      const contract = CANONICAL_TOOL_CONTRACTS[toolName];
      canonicalTools[toolName] = {
        name: toolName,
        parameters: { ...contract.parameters },
        requiredParameters: [...contract.requiredParameters],
        responseProperties: { ...contract.responseProperties },
        requiredResponseProperties: [...contract.requiredResponseProperties],
      };
    }

    it("returns healthy: true and status: 'ready' when protocol version is 1 and all 8 canonical tools match", () => {
      const health = evaluateCompanionHealth({
        protocol_version: PROTOCOL_VERSION,
        reachable: true,
        tools: canonicalTools,
      });

      expect(health.healthy).toBe(true);
      expect(health.status).toBe("ready");
      expect(health.missing_tools).toHaveLength(0);
      expect(health.schema_errors).toHaveLength(0);
      expect(health.reasons).toHaveLength(0);
    });

    it("classifies health as 'stale' (not healthy) when any canonical tool is missing", () => {
      const incompleteTools = { ...canonicalTools };
      delete incompleteTools["get_profile"];
      delete incompleteTools["preview_configuration"];

      const health = evaluateCompanionHealth({
        protocol_version: PROTOCOL_VERSION,
        reachable: true,
        tools: incompleteTools,
      });

      expect(health.healthy).toBe(false);
      expect(health.status).toBe("stale");
      expect(health.missing_tools).toContain("get_profile");
      expect(health.missing_tools).toContain("preview_configuration");
      expect(health.reasons.some((r) => r.includes("Missing canonical tools"))).toBe(true);
    });

    it("classifies health as 'stale' (not healthy) when input parameter schema mismatches", () => {
      const corruptedTools = JSON.parse(JSON.stringify(canonicalTools));
      // Remove required parameter 'profile' from save_profile
      delete corruptedTools["save_profile"].parameters["profile"];
      corruptedTools["save_profile"].requiredParameters = [];

      const health = evaluateCompanionHealth({
        protocol_version: PROTOCOL_VERSION,
        reachable: true,
        tools: corruptedTools,
      });

      expect(health.healthy).toBe(false);
      expect(health.status).toBe("stale");
      expect(health.schema_errors.some((e) => e.includes("Tool 'save_profile' is missing required parameter 'profile'"))).toBe(true);
    });

    it("classifies health as 'stale' (not healthy) when response property schema mismatches", () => {
      const corruptedTools = JSON.parse(JSON.stringify(canonicalTools));
      // Remove required response property 'profile' from save_profile
      delete corruptedTools["save_profile"].responseProperties["profile"];
      corruptedTools["save_profile"].requiredResponseProperties = [];

      const health = evaluateCompanionHealth({
        protocol_version: PROTOCOL_VERSION,
        reachable: true,
        tools: corruptedTools,
      });

      expect(health.healthy).toBe(false);
      expect(health.status).toBe("stale");
      expect(health.schema_errors.some((e) => e.includes("Tool 'save_profile' is missing required response property 'profile'"))).toBe(true);
    });

    it("classifies health as 'unsupported' (not healthy) when protocol version mismatches", () => {
      const health = evaluateCompanionHealth({
        protocol_version: 2, // Future or invalid version
        reachable: true,
        tools: canonicalTools,
      });

      expect(health.healthy).toBe(false);
      expect(health.status).toBe("unsupported");
      expect(health.reasons.some((r) => r.includes("Protocol version mismatch"))).toBe(true);
    });

    it("classifies health as not healthy when process is unreachable", () => {
      const health = evaluateCompanionHealth({
        protocol_version: PROTOCOL_VERSION,
        reachable: false,
        tools: canonicalTools,
      });

      expect(health.healthy).toBe(false);
      expect(health.status).not.toBe("ready");
      expect(health.reasons.some((r) => r.includes("unreachable"))).toBe(true);
    });
  });
});
