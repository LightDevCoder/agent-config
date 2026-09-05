import { ExecutionConfig, AgentProfile } from "../profile/schema.js";

/**
 * Unified Host Adapter contract for cross-harness capability inspection and configuration.
 */

export type CapabilityState = "available" | "unavailable" | "unknown";

export interface HostModelEvidence {
  kind: "host-runtime" | "host-config" | "host-schema" | "adapter-probe" | "user-confirmed";
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
    reasoning?: CapabilityEntry;
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

/**
 * Host version compatibility classifications (§21, §22).
 */
export type HostVersionCompatibility =
  | "supported"
  | "partially-supported"
  | "unknown-version"
  | "incompatible";

export interface HostVersionInfo {
  version?: string;
  compatibility: HostVersionCompatibility;
  fail_closed_for_mutation: boolean;
  raw?: string;
}

/**
 * Native reasoning options per host harness (§11, §19).
 */
export interface HostReasoningOptions {
  native_field: string;
  supported_values: string[];
  default_value?: string;
}

/**
 * Execution topology capabilities of the host harness (§19, §63).
 */
export interface TopologyCapabilities {
  supports_single_session: boolean;
  supports_subagents: boolean;
  supports_multi_agent: boolean;
  supports_parallel_execution: boolean;
  max_concurrency?: number;
  scopes?: Array<"current-session" | "new-session" | "per-agent">;
}

/**
 * Companion registration status and configuration (§19, §71).
 */
export interface CompanionRegistrationStatus {
  registered: boolean;
  configured?: boolean;
  reachable?: boolean;
  healthy?: boolean;
  transport?: "stdio" | "sse" | "websocket" | "http";
  command?: string;
  args?: string[];
  target_file?: string;
  scope?: "project" | "global";
  locator?: string;
  details?: unknown;
}

/**
 * Companion registration preview (§19, §71).
 */
export interface CompanionRegistrationPreview {
  supported: boolean;
  adapter_id?: string;
  host_id?: string;
  host_version?: string;
  scope?: "project" | "global" | "user";
  preview_id?: string;
  preview_hash?: string;
  target_file?: string;
  baseline_hash?: string | null;
  diff?: string;
  mutation_targets: string[];
  files?: RenderedFile[];
  error?: string;
  raw?: unknown;
}

/**
 * Host-neutral abstract reasoning policy resolution result (§11, §12).
 */
export interface ResolvedReasoningPolicy {
  host_field: string;
  host_value: string;
}

export interface HostAdapter {
  readonly id: string;
  readonly name: string;
  readonly aliases?: string[];

  identifyHost(workspaceRoot?: string): Promise<boolean>;
  inspectVersion(workspaceRoot?: string): Promise<HostVersionInfo>;
  inspectCapabilities(workspaceRoot?: string): Promise<HostCapabilities>;
  inspectModels(workspaceRoot?: string): Promise<HostModel[]>;
  inspectEffortValues?(workspaceRoot?: string): Promise<string[]>;
  inspectReasoningOptions(workspaceRoot?: string): Promise<HostReasoningOptions>;
  inspectExecutionTopologyCapabilities(workspaceRoot?: string): Promise<TopologyCapabilities>;
  inspectCompanionRegistration(
    workspaceRoot?: string,
    scope?: "project" | "global" | "user"
  ): Promise<CompanionRegistrationStatus>;
  previewCompanionRegistration(
    workspaceRoot?: string,
    scope?: "project" | "global" | "user"
  ): Promise<CompanionRegistrationPreview>;
  applyCompanionRegistration(
    previewHash: string,
    workspaceRoot?: string,
    preview?: CompanionRegistrationPreview
  ): Promise<ApplyResult>;
  validateCompanionRegistration(workspaceRoot?: string): Promise<ValidationResult>;
  previewConfiguration(
    plan: ExecutionConfig,
    profile?: AgentProfile,
    workspaceRoot?: string
  ): Promise<RenderedConfiguration>;
  renderConfiguration?(
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
  resolveReasoningPolicy?(
    policy: string,
    modelId?: string,
    workspaceRoot?: string
  ): Promise<ResolvedReasoningPolicy | undefined>;
  hasActiveRuntimeContext?(workspaceRoot?: string): Promise<boolean> | boolean;
}

/**
 * Resolves an abstract reasoning policy ("highest-supported", "lowest-sufficient", "configured", or concrete value)
 * against a host adapter, mapping into the host's native representation without hardcoding "effort" globally (§11, §12).
 */
export async function resolveHostReasoningPolicy(
  adapter: HostAdapter,
  policy: string,
  modelId?: string,
  workspaceRoot?: string
): Promise<ResolvedReasoningPolicy | undefined> {
  if (adapter.resolveReasoningPolicy) {
    return adapter.resolveReasoningPolicy(policy, modelId, workspaceRoot);
  }

  const options = await adapter.inspectReasoningOptions(workspaceRoot);
  if (!options || !options.native_field || options.supported_values.length === 0) {
    return undefined;
  }

  const values = options.supported_values;
  const normalized = policy.toLowerCase().trim();

  let selectedValue: string | undefined;

  if (normalized === "highest-supported") {
    if (values.includes("xhigh")) selectedValue = "xhigh";
    else if (values.includes("high")) selectedValue = "high";
    else if (values.includes("max")) selectedValue = "max";
    else selectedValue = values[values.length - 1];
  } else if (normalized === "lowest-sufficient" || normalized === "lowest-supported") {
    if (values.includes("low")) selectedValue = "low";
    else if (values.includes("min")) selectedValue = "min";
    else selectedValue = values[0];
  } else if (normalized === "configured") {
    selectedValue = options.default_value || values[0];
  } else if (values.includes(policy)) {
    selectedValue = policy;
  } else {
    const match = values.find((v) => v.toLowerCase() === normalized);
    if (match) {
      selectedValue = match;
    }
  }

  if (!selectedValue) {
    return undefined;
  }

  return {
    host_field: options.native_field,
    host_value: selectedValue,
  };
}
