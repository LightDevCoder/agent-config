import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
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
  validateCompanionSetup,
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

describe("Gate 2: Cross-Repo Call Chain Integration (agent-config <-> implement)", () => {
  let tempDir: string;
  let workspaceDir: string;
  let store: ProfileStore;
  let registry: AdapterRegistry;

  const validHostCapabilities: HostCapabilities = {
    host_id: "host-cross-repo",
    adapter_id: "generic",
    observed_at: new Date().toISOString(),
    available_models: [
      { id: "claude-sonnet-4", state: "available" },
      { id: "claude-opus-4", state: "available" },
      { id: "claude-haiku-3.5", state: "available" },
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
      id: "host-cross-repo",
      adapter: "generic",
    },
    scope: {
      type: "project",
      workspace: "/dummy/workspace",
    },
    model_mode: "single",
    single_model: {
      model: "claude-sonnet-4",
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

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-config-gate2-test-"));
    workspaceDir = path.join(tempDir, "workspace");
    await fsp.mkdir(workspaceDir, { recursive: true });

    store = new ProfileStore({ baseDir: path.join(tempDir, "profiles") });
    registry = new AdapterRegistry();
  });

  afterEach(async () => {
    if (fs.existsSync(tempDir)) {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  // ==========================================================================
  // 1. Happy Path: Ticket Item -> Implement Offer -> Accept -> Agent Config READY -> Implement Consumes
  // ==========================================================================
  describe("Happy Path: Ticket Item -> Plan Execution -> READY -> Implement Consumes", () => {
    it("completes full call chain from ticket inspection to execution config consumption", async () => {
      // 1. Persist user profile
      const profileToSave: Profile = {
        ...sampleSingleProfile,
        scope: { type: "project", workspace: workspaceDir },
      };
      await store.saveProfile(profileToSave, workspaceDir);

      // 2. Define task with ticket
      const task = {
        name: "implement user authentication token",
        files: ["auth.ts", "session.ts", "token.ts", "test_auth.ts"],
        change_units: ["auth", "token"],
        ticket: ".scratch/auth-feature/issues/01-auth-token.md",
      };

      // 3. Implement evaluates routing need and offers choice
      const offerDecision = ImplementDecisionEngine.decideAction(task);
      expect(offerDecision.action).toBe("await_user_choice");
      expect(offerDecision.offered_agent_config).toBe(true);

      // 4. agent-config plans execution for the ticket item
      const execConfig: ExecutionConfig = {
        readiness: "executable",
        task_shape: "single-pass",
        model_mode: "single",
        topology: {
          type: "single-session",
          concurrency: 1,
        },
        execution: {
          model: "claude-sonnet-4",
          effort: "high",
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
          effort: "high",
          context: "current-session",
        },
      };

      // Validate execution config against profile & host capabilities
      const valResult = validateExecutionConfig(
        execConfig,
        profileToSave,
        validHostCapabilities
      );
      expect(valResult.valid).toBe(true);
      expect(valResult.errors).toBeUndefined();

      // Create authoritative AgentConfigResult
      const agentConfigResult = createAgentConfigResult({
        readiness: "READY",
        mode: "persisted",
        setup_state: { companion: "ready", profile: "persisted" },
        handoff: "implement",
        execution_config: execConfig,
        reason: "Single-pass ticket implementation ready with persisted profile",
      });

      // Verify two-layer envelope contract
      expect(agentConfigResult.readiness).toBe("READY");
      expect(agentConfigResult.execution_config).not.toBeNull();
      expect(agentConfigResult.handoff).toBe("implement");
      expect(() => AgentConfigResultSchema.parse(agentConfigResult)).not.toThrow();

      // 5. User accepts offer; implement consumes AgentConfigResult
      const executeDecision = ImplementDecisionEngine.decideAction(task, {
        userChoiceResponse: "accept",
        agentConfigResult,
      });

      expect(executeDecision.action).toBe("execute_with_agent_config");
      expect(executeDecision.offered_agent_config).toBe(true);
      expect(executeDecision.invoked_agent_config).toBe(true);
      expect(executeDecision.execution_config).toBeDefined();
      expect(executeDecision.execution_config?.execution.model).toBe("claude-sonnet-4");
      expect(
        executeDecision.execution_config?.execution.reasoning?.resolved.host_value
      ).toBe("high");
      expect(executeDecision.handoff).toBe("implement");
    });
  });

  // ==========================================================================
  // 2. Failure Path 1: Missing Profile -> NEED_INPUT -> Setup Offer & Safe Fallback
  // ==========================================================================
  describe("Failure Path 1: Missing Profile -> NEED_INPUT -> Setup Offer & Fallback", () => {
    it("returns NEED_INPUT with null execution_config and hands off to setup or falls back safely", async () => {
      // 1. Store is empty for this workspace
      const loadedProfile = await store.getProfile("host-cross-repo", workspaceDir);
      expect(loadedProfile).toBeNull();

      // 2. Task with complex routing value
      const task = {
        name: "complex refactor without profile",
        files: ["a.ts", "b.ts", "c.ts", "d.ts"],
        change_units: ["a", "b", "c"],
      };

      // 3. agent-config outputs NEED_INPUT
      const agentConfigResult = createAgentConfigResult({
        readiness: "NEED_INPUT",
        mode: "plan-only",
        setup_state: { companion: "ready", profile: "missing" },
        handoff: "setup",
        execution_config: null,
        reason: "Host environment has no user-confirmed profile configured",
      });

      expect(agentConfigResult.readiness).toBe("NEED_INPUT");
      expect(agentConfigResult.execution_config).toBeNull();
      expect(agentConfigResult.handoff).toBe("setup");
      expect(agentConfigResult.setup_state.profile).toBe("missing");
      expect(() => AgentConfigResultSchema.parse(agentConfigResult)).not.toThrow();

      // Invariant: execution_config must be null when readiness != READY
      expect(() =>
        createAgentConfigResult({
          readiness: "NEED_INPUT",
          mode: "plan-only",
          setup_state: { companion: "ready", profile: "missing" },
          handoff: "setup",
          execution_config: {} as any,
        })
      ).toThrow("Invariant violation: execution_config must be null when readiness is 'NEED_INPUT'");

      // 4. Implement receives NEED_INPUT -> offers setup
      const offerSetup = ImplementDecisionEngine.decideAction(task, {
        userChoiceResponse: "accept",
        agentConfigResult,
      });
      expect(offerSetup.action).toBe("offer_setup");
      expect(offerSetup.handoff).toBe("setup");
      expect(offerSetup.profile_state).toBe("missing");

      // 5. User accepts setup -> hands off to setup
      const acceptSetup = ImplementDecisionEngine.decideAction(task, {
        userChoiceResponse: "accept",
        agentConfigResult,
        userSetupResponse: "accept",
      });
      expect(acceptSetup.action).toBe("handoff_to_setup");
      expect(acceptSetup.handoff).toBe("setup");

      // 6. User declines setup -> safe fallback to direct single-agent execution without blocking
      const declineSetup = ImplementDecisionEngine.decideAction(task, {
        userChoiceResponse: "accept",
        agentConfigResult,
        userSetupResponse: "decline",
      });
      expect(declineSetup.action).toBe("execute_direct");
      expect(declineSetup.action).not.toBe("BLOCKED");
    });
  });

  // ==========================================================================
  // 3. Failure Path 2: Decomposed Without Tickets -> NEED_PROJECT_TICKETS Handoff
  // ==========================================================================
  describe("Failure Path 2: Decomposed Without Tickets -> NEED_PROJECT_TICKETS -> Halts", () => {
    it("emits NEED_PROJECT_TICKETS, strictly null execution_config, and halts implement execution", () => {
      const task = {
        name: "overhaul entire payment architecture",
        files: ["gateway.ts", "webhook.ts", "ledger.ts", "retry.ts", "crypto.ts"],
        change_units: ["gateway", "webhook", "ledger"],
        requires_ticket_decomposition: true,
      };

      // agent-config detects decomposed shape without formal tickets
      const agentConfigResult = createAgentConfigResult({
        readiness: "NEED_PROJECT_TICKETS",
        mode: "persisted",
        setup_state: { companion: "ready", profile: "persisted" },
        handoff: "project-tickets",
        execution_config: null,
        reason: "Decomposed task requires formal tickets before implementation can proceed",
      });

      expect(agentConfigResult.readiness).toBe("NEED_PROJECT_TICKETS");
      expect(agentConfigResult.execution_config).toBeNull();
      expect(agentConfigResult.handoff).toBe("project-tickets");
      expect(() => AgentConfigResultSchema.parse(agentConfigResult)).not.toThrow();

      // Implement consumption halts implementation and hands off
      const decision = ImplementDecisionEngine.decideAction(task, {
        userChoiceResponse: "accept",
        agentConfigResult,
      });

      expect(decision.action).toBe("handoff_to_project_tickets");
      expect(decision.handoff).toBe("project-tickets");
      expect(decision.halted).toBe(true);
      expect(decision.reason).toContain("formal tickets");
    });
  });

  // ==========================================================================
  // 4. Failure Path 3: Unauthorized Model or Unknown Capability -> BLOCKED / UNSUPPORTED
  // ==========================================================================
  describe("Failure Path 3: Unauthorized Model or Unknown Capability -> Core Validation Rejects", () => {
    it("rejects unauthorized model with BLOCKED and halts implementation", () => {
      const unauthorizedConfig: ExecutionConfig = {
        status: "READY",
        task_shape: "single-pass",
        model_mode: "single",
        topology: { type: "single-session", concurrency: 1 },
        execution: {
          model: "unauthorized-gpt-5",
          effort: "high",
          context: "current-session",
        },
        review: {
          strategy: "self-check",
          model: "unauthorized-gpt-5",
          context: "current-session",
        },
      };

      // Core validation check
      const validation = validateExecutionConfig(
        unauthorizedConfig,
        sampleSingleProfile,
        validHostCapabilities
      );
      expect(validation.valid).toBe(false);
      expect(
        validation.errors?.some((e) => e.includes("not explicitly authorized"))
      ).toBe(true);

      const agentConfigResult = createAgentConfigResult({
        readiness: "BLOCKED",
        mode: "persisted",
        setup_state: { companion: "ready", profile: "persisted" },
        handoff: null,
        execution_config: null,
        reason: "Selected model 'unauthorized-gpt-5' is not authorized in user profile",
        diagnostics: validation.errors,
      });

      expect(agentConfigResult.readiness).toBe("BLOCKED");
      expect(agentConfigResult.execution_config).toBeNull();
      expect(() => AgentConfigResultSchema.parse(agentConfigResult)).not.toThrow();

      const decision = ImplementDecisionEngine.decideAction(
        { name: "task" },
        { userIntent: "explicit_enable", agentConfigResult }
      );
      expect(decision.action).toBe("BLOCKED");
      expect(decision.halted).toBe(true);
      expect(decision.reason).toContain("not authorized");
      expect(decision.diagnostics).toEqual(validation.errors);
    });

    it("rejects unevidenced model with BLOCKED even if present in legacy profile", () => {
      const unevidencedConfig: ExecutionConfig = {
        status: "READY",
        task_shape: "single-pass",
        model_mode: "single",
        topology: { type: "single-session", concurrency: 1 },
        execution: {
          model: "claude-sonnet-4",
          effort: "high",
          context: "current-session",
        },
        review: {
          strategy: "self-check",
          model: "claude-sonnet-4",
          context: "current-session",
        },
      };

      // Host has NO models available
      const emptyHostCapabilities: HostCapabilities = {
        ...validHostCapabilities,
        available_models: [],
      };

      const validation = validateExecutionConfig(
        unevidencedConfig,
        sampleSingleProfile,
        emptyHostCapabilities
      );
      expect(validation.valid).toBe(false);
      expect(validation.errors.some((e) => e.includes("not evidenced"))).toBe(true);

      const agentConfigResult = createAgentConfigResult({
        readiness: "BLOCKED",
        mode: "persisted",
        setup_state: { companion: "ready", profile: "persisted" },
        handoff: null,
        execution_config: null,
        reason: "Configured model 'claude-sonnet-4' is not evidenced as available on host",
        diagnostics: validation.errors,
      });

      const decision = ImplementDecisionEngine.decideAction(
        { name: "task" },
        { userIntent: "explicit_enable", agentConfigResult }
      );
      expect(decision.action).toBe("BLOCKED");
      expect(decision.halted).toBe(true);
    });

    it("rejects unsupported capability with UNSUPPORTED and halts implementation", () => {
      const agentConfigResult = createAgentConfigResult({
        readiness: "UNSUPPORTED",
        mode: "persisted",
        setup_state: { companion: "ready", profile: "persisted" },
        handoff: null,
        execution_config: null,
        reason: "Host runtime does not support required capability 'subagents'",
        diagnostics: ["capabilities.subagents is false or unknown"],
      });

      expect(agentConfigResult.readiness).toBe("UNSUPPORTED");
      expect(agentConfigResult.execution_config).toBeNull();
      expect(() => AgentConfigResultSchema.parse(agentConfigResult)).not.toThrow();

      const decision = ImplementDecisionEngine.decideAction(
        { name: "task" },
        { userIntent: "explicit_enable", agentConfigResult }
      );
      expect(decision.action).toBe("UNSUPPORTED");
      expect(decision.halted).toBe(true);
      expect(decision.reason).toContain("capability 'subagents'");
    });
  });

  // ==========================================================================
  // 5. Companion Health Semantics
  // ==========================================================================
  describe("Companion Health Semantics: Strict Evaluation against CANONICAL_TOOL_CONTRACTS", () => {
    // Helper to generate canonical tool definitions for all 8 tools
    function getValidCanonicalTools() {
      return TOOL_NAMES.map((toolName) => {
        const canonical = CANONICAL_TOOL_CONTRACTS[toolName];
        return {
          name: canonical.name,
          description: canonical.description,
          parameters: canonical.parameters,
          requiredParameters: canonical.requiredParameters,
          responseProperties: canonical.responseProperties,
          requiredResponseProperties: canonical.requiredResponseProperties,
        };
      });
    }

    it("evaluates healthy companion as ready when all 8 tools and protocol match", () => {
      const tools = getValidCanonicalTools();
      const health = evaluateCompanionHealth({
        protocol_version: PROTOCOL_VERSION,
        tools,
        reachable: true,
      });

      expect(health.healthy).toBe(true);
      expect(health.status).toBe("ready");
      expect(health.missing_tools).toHaveLength(0);
      expect(health.schema_errors).toHaveLength(0);
      expect(health.reasons).toHaveLength(0);
    });

    it("marks companion as unsupported when protocol_version != 1", () => {
      const tools = getValidCanonicalTools();
      const healthMismatch = evaluateCompanionHealth({
        protocol_version: 2, // incompatible protocol version
        tools,
        reachable: true,
      });

      expect(healthMismatch.healthy).toBe(false);
      expect(healthMismatch.status).toBe("unsupported");
      expect(healthMismatch.reasons.some((r) => r.includes("Protocol version mismatch"))).toBe(
        true
      );
    });

    it("marks companion as stale when any canonical tool is missing", () => {
      // Omit 'reset_profile' (only 7 tools)
      const incompleteTools = getValidCanonicalTools().filter(
        (t) => t.name !== "reset_profile"
      );

      const health = evaluateCompanionHealth({
        protocol_version: PROTOCOL_VERSION,
        tools: incompleteTools,
        reachable: true,
      });

      expect(health.healthy).toBe(false);
      expect(health.status).toBe("stale");
      expect(health.missing_tools).toContain("reset_profile");
      expect(health.reasons.some((r) => r.includes("Missing canonical tools"))).toBe(true);
    });

    it("marks companion as stale when tool schema is missing required parameter", () => {
      const tools = getValidCanonicalTools().map((tool) => {
        if (tool.name === "save_profile") {
          // Mutate save_profile to drop required 'profile' parameter
          return {
            ...tool,
            requiredParameters: [],
            parameters: {},
          };
        }
        return tool;
      });

      const health = evaluateCompanionHealth({
        protocol_version: PROTOCOL_VERSION,
        tools,
        reachable: true,
      });

      expect(health.healthy).toBe(false);
      expect(health.status).toBe("stale");
      expect(
        health.schema_errors.some(
          (err) =>
            err.includes("save_profile") && err.includes("missing required parameter 'profile'")
        )
      ).toBe(true);
    });

    it("marks companion as stale when tool parameter type is incompatible", () => {
      const tools = getValidCanonicalTools().map((tool) => {
        if (tool.name === "preview_configuration") {
          return {
            ...tool,
            parameters: {
              ...tool.parameters,
              config: { type: "string", required: true }, // incompatible: expected object
            },
          };
        }
        return tool;
      });

      const health = evaluateCompanionHealth({
        protocol_version: PROTOCOL_VERSION,
        tools,
        reachable: true,
      });

      expect(health.healthy).toBe(false);
      expect(health.status).toBe("stale");
      expect(
        health.schema_errors.some(
          (err) =>
            err.includes("preview_configuration") &&
            err.includes("incompatible type: expected 'object', got 'string'")
        )
      ).toBe(true);
    });

    it("marks companion as unhealthy when process is unreachable", () => {
      const tools = getValidCanonicalTools();
      const health = evaluateCompanionHealth({
        protocol_version: PROTOCOL_VERSION,
        tools,
        reachable: false,
      });

      expect(health.healthy).toBe(false);
      expect(health.reasons.some((r) => r.includes("unreachable"))).toBe(true);
    });

    it("integrates strict health check into validateCompanionSetup lifecycle", async () => {
      await fsp.mkdir(path.join(workspaceDir, ".codex"), { recursive: true });
      await fsp.writeFile(
        path.join(workspaceDir, ".codex", "config.toml"),
        '[mcp_servers.agent-config]\ncommand = "agent-config"\nargs = ["serve"]\n',
        "utf-8"
      );

      // 1. With valid canonical tools, validation passes with healthy: true
      const validTools = getValidCanonicalTools();
      const validValidation = await validateCompanionSetup({
        workspace: workspaceDir,
        host_id: "codex",
        registry,
        tools: validTools,
      });
      expect(validValidation.registered).toBe(true);
      expect(validValidation.configured).toBe(true);
      expect(validValidation.reachable).toBe(true);
      expect(validValidation.healthy).toBe(true);
      expect(validValidation.health?.status).toBe("ready");

      // 2. With incomplete tools (missing reset_profile), validation fails with healthy: false
      const malformedTools = validTools.filter((t) => t.name !== "reset_profile");
      const malformedValidation = await validateCompanionSetup({
        workspace: workspaceDir,
        host_id: "codex",
        registry,
        tools: malformedTools,
      });
      expect(malformedValidation.valid).toBe(false);
      expect(malformedValidation.healthy).toBe(false);
      expect(malformedValidation.health?.status).toBe("stale");
      expect(
        malformedValidation.errors?.some((e) => e.includes("Missing canonical tools"))
      ).toBe(true);
    });
  });
});
