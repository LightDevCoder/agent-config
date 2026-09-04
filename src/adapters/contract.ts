import { ExecutionConfig, AgentProfile } from "../profile/schema.js";

/**
 * Unified Host Adapter contract for cross-harness capability inspection and configuration.
 */

export type CapabilityState = "available" | "unavailable" | "unknown";

export interface HostModelEvidence {
  kind: "host-runtime" | "host-config" | "adapter-probe" | "fallback-default";
  locator: string;
  observed_at?: string;
}

export interface HostModel {
  id: string;
  label?: string;
  state: CapabilityState;
  features?: string[];
  evidence?: HostModelEvidence;
}

export type HostModelInfo = HostModel;

export interface CapabilityEntry {
  state: CapabilityState;
  evidence?: HostModelEvidence;
}

export interface ModelSelectionCapability {
  state: CapabilityState;
  scopes?: Array<"current-session" | "new-session" | "per-agent">;
  evidence?: HostModelEvidence;
}

export interface ConcurrencyCapability {
  state: CapabilityState;
  max_concurrency?: number;
  evidence?: HostModelEvidence;
}

export interface ConfigurationMutationCapability {
  state: CapabilityState;
  supports_native_files?: boolean;
  supports_session_mutation?: boolean;
  evidence?: HostModelEvidence;
}

export interface HostCapabilities {
  host_id: string;
  adapter_id: string;
  workspace?: string;
  observed_at: string;
  platform?: string;
  available_models: HostModel[];
  supported_effort_values: string[];
  default_effort_value?: string;
  capabilities: {
    subagents: CapabilityEntry;
    threads: CapabilityEntry;
    parallelism: CapabilityEntry;
    model_selection: ModelSelectionCapability;
    per_agent_model_selection?: CapabilityEntry;
    concurrency?: ConcurrencyCapability;
    configuration_mutation?: ConfigurationMutationCapability;
  };
}

export interface RenderedFile {
  path: string;
  content: string;
}

export interface RenderedConfiguration {
  preview_id: string;
  mutation_targets: string[];
  diff: string;
  files?: RenderedFile[];
  raw?: unknown;
}

export type ConfigurationRenderResult = RenderedConfiguration;

export interface ApplyResult {
  success: boolean;
  preview_id: string;
  applied_targets: string[];
  message?: string;
  error?: string;
}

export interface ValidationResult {
  valid: boolean;
  workspace?: string;
  message?: string;
  errors?: string[];
  details?: unknown;
}

export interface HostAdapter {
  readonly id: string;
  readonly name: string;

  identifyHost(workspaceRoot?: string): Promise<boolean>;
  inspectCapabilities(workspaceRoot?: string): Promise<HostCapabilities>;
  inspectModels(workspaceRoot?: string): Promise<HostModel[]>;
  inspectEffortValues(workspaceRoot?: string): Promise<string[]>;
  renderConfiguration(
    plan: ExecutionConfig,
    profile?: AgentProfile,
    workspaceRoot?: string
  ): Promise<RenderedConfiguration>;
  applyConfiguration(
    previewId: string,
    rendered?: RenderedConfiguration,
    workspaceRoot?: string
  ): Promise<ApplyResult>;
  validateConfiguration(
    expected: ExecutionConfig,
    workspaceRoot?: string
  ): Promise<ValidationResult>;
}
