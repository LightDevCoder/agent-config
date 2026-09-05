import {
  HostAdapter,
  HostCapabilities,
  HostModel,
  RenderedConfiguration,
  ApplyResult,
  ValidationResult,
  HostVersionInfo,
  HostReasoningOptions,
  TopologyCapabilities,
  CompanionRegistrationStatus,
  CompanionRegistrationPreview,
  ResolvedReasoningPolicy,
} from "../contract.js";
import { ExecutionConfig, AgentProfile } from "../../profile/schema.js";

/**
 * Generic / Manual fallback adapter for environments without a dedicated adapter.
 * Plan-only: does not perform host-specific native file mutations.
 * Strictly distinguishes available, unavailable, and unknown capabilities.
 */
export class GenericAdapter implements HostAdapter {
  readonly id = "generic";
  readonly name = "Generic / Manual Adapter";

  hasActiveRuntimeContext(_workspaceRoot?: string): boolean {
    return false;
  }

  async identifyHost(_workspaceRoot?: string): Promise<boolean> {
    // Acts as universal fallback adapter
    return true;
  }

  async inspectVersion(_workspaceRoot?: string): Promise<HostVersionInfo> {
    return {
      version: undefined,
      compatibility: "supported",
      fail_closed_for_mutation: true,
    };
  }

  async inspectReasoningOptions(
    _workspaceRoot?: string
  ): Promise<HostReasoningOptions> {
    return {
      native_field: "reasoning",
      supported_values: [],
    };
  }

  async inspectExecutionTopologyCapabilities(
    _workspaceRoot?: string
  ): Promise<TopologyCapabilities> {
    return {
      supports_single_session: true,
      supports_subagents: false,
      supports_multi_agent: false,
      supports_parallel_execution: false,
      scopes: ["current-session"],
    };
  }

  async inspectCompanionRegistration(
    _workspaceRoot?: string,
    _scope?: "project" | "global" | "user"
  ): Promise<CompanionRegistrationStatus> {
    return {
      registered: false,
      scope: "project",
      locator: "unsupported",
      details: "Generic host does not support automatic companion registration",
    };
  }

  async previewCompanionRegistration(
    _workspaceRoot?: string,
    scope?: "project" | "global" | "user"
  ): Promise<CompanionRegistrationPreview> {
    const resolvedScope: "project" | "global" =
      scope === "user" || scope === "global" ? "global" : "project";
    return {
      supported: false,
      adapter_id: this.id,
      host_id: this.id,
      scope: resolvedScope,
      mutation_targets: [],
      error: "Companion registration mutation is unsupported for generic host.",
    };
  }

  async applyCompanionRegistration(
    previewHash: string,
    _workspaceRoot?: string,
    _providedPreview?: CompanionRegistrationPreview
  ): Promise<ApplyResult> {
    return {
      success: false,
      preview_id: previewHash,
      applied_targets: [],
      error: "Companion registration mutation is unsupported for generic host.",
    };
  }

  async validateCompanionRegistration(
    _workspaceRoot?: string
  ): Promise<ValidationResult> {
    return {
      valid: false,
      message: "Generic adapter does not support companion registration.",
    };
  }

  async previewConfiguration(
    plan: ExecutionConfig,
    profile?: AgentProfile,
    workspaceRoot?: string
  ): Promise<RenderedConfiguration> {
    return this.renderConfiguration(plan, profile, workspaceRoot);
  }

  async resolveReasoningPolicy(
    _policy: string,
    _modelId?: string,
    _workspaceRoot?: string
  ): Promise<ResolvedReasoningPolicy | undefined> {
    return undefined;
  }

  async inspectCapabilities(workspaceRoot?: string): Promise<HostCapabilities> {
    return {
      host_id: "generic",
      adapter_id: "generic",
      workspace: workspaceRoot,
      observed_at: new Date().toISOString(),
      available_models: [],
      supported_effort_values: [],
      capabilities: {
        subagents: { state: "unknown" },
        threads: { state: "unknown" },
        parallelism: { state: "unknown" },
        model_selection: {
          state: "unknown",
          scopes: ["current-session"],
        },
        concurrency: { state: "unknown" },
        configuration_mutation: {
          state: "unavailable",
          supports_native_files: false,
          supports_session_mutation: false,
        },
        reasoning: { state: "unknown" },
      },
    };
  }

  async inspectModels(_workspaceRoot?: string): Promise<HostModel[]> {
    return [];
  }

  async inspectEffortValues(_workspaceRoot?: string): Promise<string[]> {
    return [];
  }

  async renderConfiguration(
    plan: ExecutionConfig,
    _profile?: AgentProfile,
    workspaceRoot?: string
  ): Promise<RenderedConfiguration> {
    const previewId = `preview-generic-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const diff =
      `# Generic Plan-Only Configuration Preview\n` +
      `Workspace: ${workspaceRoot || "none"}\n` +
      `Mutation Targets: None (plan-only manual execution)\n` +
      `Task Shape: ${plan?.task_shape}\n` +
      `Topology: ${plan?.topology?.type || "single-session"} (concurrency: ${plan?.topology?.concurrency || 1})\n\n` +
      JSON.stringify(plan, null, 2) +
      "\n";

    return {
      preview_id: previewId,
      mutation_targets: [],
      diff,
      files: [],
    };
  }

  async applyConfiguration(
    previewId: string,
    rendered?: RenderedConfiguration,
    _workspaceRoot?: string
  ): Promise<ApplyResult> {
    if (!rendered) {
      return {
        success: false,
        preview_id: previewId,
        applied_targets: [],
        error: "No rendered configuration provided to apply.",
      };
    }

    if (rendered.preview_id && previewId !== rendered.preview_id) {
      return {
        success: false,
        preview_id: previewId,
        applied_targets: [],
        error: `Preview ID mismatch: expected ${rendered.preview_id}, got ${previewId}.`,
      };
    }

    return {
      success: true,
      preview_id: previewId,
      applied_targets: [],
      message: "Generic adapter is plan-only: no host mutations performed.",
    };
  }

  async validateConfiguration(
    _expected: ExecutionConfig,
    workspaceRoot?: string
  ): Promise<ValidationResult> {
    return {
      valid: true,
      workspace: workspaceRoot,
      message: "Generic adapter is plan-only: host state validation is manual.",
    };
  }
}
