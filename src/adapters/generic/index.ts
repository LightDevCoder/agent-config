import {
  HostAdapter,
  HostCapabilities,
  HostModel,
  RenderedConfiguration,
  ApplyResult,
  ValidationResult,
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

  async identifyHost(_workspaceRoot?: string): Promise<boolean> {
    // Acts as universal fallback adapter
    return true;
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
    _rendered?: RenderedConfiguration,
    _workspaceRoot?: string
  ): Promise<ApplyResult> {
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
