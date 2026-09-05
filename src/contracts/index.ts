import { z } from "zod";
import {
  Profile,
  ProfileSchema,
  ExecutionConfig,
  ExecutionConfigSchema,
  Reasoning,
  ReasoningSchema,
  ReadinessState,
  ReadinessStateSchema,
  ModeState,
  ModeStateSchema,
  SetupState,
  SetupStateSchema,
  HandoffTarget,
  HandoffTargetSchema,
  AgentConfigResult,
  AgentConfigResultSchema,
  createAgentConfigResult,
} from "../profile/schema.js";
import { HostCapabilities, CompanionRegistrationStatus } from "../adapters/contract.js";

export {
  Profile,
  ProfileSchema,
  ExecutionConfig,
  ExecutionConfigSchema,
  Reasoning,
  ReasoningSchema,
  ReadinessState,
  ReadinessStateSchema,
  ModeState,
  ModeStateSchema,
  SetupState,
  SetupStateSchema,
  HandoffTarget,
  HandoffTargetSchema,
  AgentConfigResult,
  AgentConfigResultSchema,
  createAgentConfigResult,
};

/**
 * Authoritative protocol and schema versions.
 */
export const PROTOCOL_VERSION = 1 as const;
export const PROFILE_VERSION = 1 as const;

/**
 * All 8 standard MCP tools provided by the Agent Config companion server.
 */
export const TOOL_NAMES = [
  "get_setup_status",
  "inspect_host",
  "get_profile",
  "save_profile",
  "preview_configuration",
  "apply_configuration",
  "validate_configuration",
  "reset_profile",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

/**
 * Scope representation: strictly "project" or "global".
 */
export const ScopeEnum = z.enum(["project", "global"]);
export type ScopeType = z.infer<typeof ScopeEnum>;

// ============================================================================
// 1. get_setup_status
// ============================================================================

export const GetSetupStatusInputSchema = {
  scope: ScopeEnum.optional().describe("Configuration scope ('project' or 'global', defaults to 'project')"),
  workspace: z
    .string()
    .optional()
    .describe("Workspace directory path (defaults to current working directory)"),
  host_id: z
    .string()
    .optional()
    .describe("Host identifier (optional, auto-detected from adapter if omitted)"),
};

export interface SetupStatusResult {
  configured: boolean;
  protocol_version: 1;
  profile_version: number | null;
  host_id: string;
  adapter_id: string | null;
  scope: ScopeType | null;
  stale: boolean;
  stale_reasons: string[];
  companion_registered?: boolean;
  companion_status?: CompanionRegistrationStatus;
}

export const GetSetupStatusOutputSchema = z.object({
  configured: z.boolean().describe("Whether configuration exists and is valid"),
  protocol_version: z.number().describe("Agent Config companion protocol version"),
  profile_version: z.number().nullable().optional().describe("Stored profile version"),
  host_id: z.string().describe("Target harness host ID"),
  adapter_id: z.string().nullable().optional().describe("Underlying host adapter ID"),
  scope: ScopeEnum.nullable().optional().describe("Configuration scope"),
  stale: z.boolean().describe("Whether stored configuration is stale"),
  stale_reasons: z.array(z.string()).describe("Reasons why configuration is stale"),
  companion_registered: z.boolean().optional().describe("Whether companion is registered"),
}).passthrough();

// ============================================================================
// 2. inspect_host
// ============================================================================

export const InspectHostInputSchema = {
  workspace: z
    .string()
    .optional()
    .describe("Workspace directory path (defaults to current working directory)"),
  host_id: z
    .string()
    .optional()
    .describe("Host identifier (optional, auto-detected if omitted)"),
};

export type InspectHostResult = HostCapabilities;

export const InspectHostOutputSchema = z.object({
  host_id: z.string().describe("Target host ID"),
  adapter_id: z.string().describe("Adapter ID"),
  workspace: z.string().optional().describe("Workspace path"),
  observed_at: z.string().describe("ISO timestamp of observation"),
  platform: z.string().optional().describe("Operating system platform"),
  available_models: z.array(z.any()).describe("Available model capabilities"),
  supported_effort_values: z.array(z.string()).describe("Supported reasoning effort values"),
  default_effort_value: z.string().optional().describe("Default reasoning effort value"),
  capabilities: z.record(z.any()).describe("Host capability flags"),
}).passthrough();

// ============================================================================
// 3. get_profile
// ============================================================================

export const GetProfileInputSchema = {
  scope: ScopeEnum.optional().describe("Configuration scope ('project' or 'global', defaults to 'project')"),
  workspace: z
    .string()
    .optional()
    .describe("Workspace directory path (defaults to current working directory)"),
  host_id: z
    .string()
    .optional()
    .describe("Host identifier (optional, auto-detected from adapter if omitted)"),
};

export interface GetProfileResult {
  found: boolean;
  profile?: Profile;
  message?: string;
}

export const GetProfileOutputSchema = z.object({
  found: z.boolean().describe("Whether stored profile was found"),
  profile: z.record(z.any()).optional().describe("Stored profile if found"),
  message: z.string().optional().describe("Informational message"),
}).passthrough();

// ============================================================================
// 4. save_profile
// ============================================================================

export const SaveProfileInputSchema = {
  profile: z.record(z.any()).describe("Complete Agent Config profile document to save"),
  workspace: z
    .string()
    .optional()
    .describe("Optional workspace path override (defaults to profile.scope.workspace)"),
};

export interface SaveProfileResult {
  success: boolean;
  message: string;
  profile: Profile;
}

export const SaveProfileOutputSchema = z.object({
  success: z.boolean().describe("Whether save operation succeeded"),
  message: z.string().describe("Save result message"),
  profile: z.record(z.any()).describe("Saved profile document"),
}).passthrough();

// ============================================================================
// 5. preview_configuration
// ============================================================================

export const PreviewConfigurationInputSchema = {
  config: z
    .record(z.any())
    .describe("Canonical ExecutionConfig object conforming to execution-config.schema.json"),
  workspace: z
    .string()
    .optional()
    .describe("Workspace directory path (defaults to current working directory)"),
  host_id: z
    .string()
    .optional()
    .describe("Host identifier (optional, auto-detected from adapter if omitted)"),
};

export interface ExtendedPreviewResult {
  preview_id: string;
  preview_hash: string;
  diff: string;
  expires_at: string;
  target: string;
  baseline_hash: string | null;
  mutation_targets: string[];
  target_hashes?: Record<string, string | null>;
  files?: Array<{ path: string; content: string }>;
  raw?: unknown;
}

export const PreviewConfigurationOutputSchema = z.object({
  preview_id: z.string().describe("Unique preview identifier"),
  preview_hash: z.string().describe("SHA-256 hash of proposed changes"),
  diff: z.string().describe("Human-readable configuration diff"),
  expires_at: z.string().describe("ISO expiration timestamp"),
  target: z.string().describe("Target configuration file path"),
  baseline_hash: z.string().nullable().optional().describe("Hash of baseline content"),
  mutation_targets: z.array(z.string()).describe("List of target paths to mutate"),
}).passthrough();

export interface FileMutationOperation {
  type: "file";
  target: string;
  action: "create" | "update" | "delete";
  diff: string;
  content?: string;
  baseline_hash: string | null;
  reversible: boolean;
}

export interface NonFileMutationOperation {
  type: "native" | "command";
  description: string;
  command?: string;
  args?: string[];
  reversible: boolean;
  undo_action?: { command: string; args: string[] };
}

export type MutationOperation = FileMutationOperation | NonFileMutationOperation;

/**
 * Canonical Frozen Mutation Preview contract (§26, §27).
 * Prevents apply from re-deriving targets, losing scope, or mutating drifted baselines.
 */
export interface FrozenMutationPreview {
  preview_id: string;
  preview_hash: string;
  adapter_id: string;
  host_id?: string;
  host_identity: string;
  host_version?: string;
  scope: "project" | "user" | "global";
  target: string;
  baseline_identity?: string;
  baseline_hash: string | null;
  mutation: {
    diff: string;
    patch?: string;
    command?: string;
    args?: string[];
    files?: Array<{ path: string; content: string }>;
  };
  operations?: MutationOperation[];
  created_at: string;
  expires_at: string;
  applied?: boolean;
}

// ============================================================================
// 6. apply_configuration
// ============================================================================

export const ApplyConfigurationInputSchema = {
  preview_id: z
    .string()
    .min(1)
    .describe("The preview ID generated by preview_configuration"),
  workspace: z
    .string()
    .optional()
    .describe("Workspace directory path (defaults to current working directory)"),
};

export interface ApplyConfigurationResult {
  success: boolean;
  preview_id: string;
  applied_targets: string[];
  target?: string;
  baseline_hash?: string | null;
  message: string;
}

export const ApplyConfigurationOutputSchema = z.object({
  success: z.boolean().describe("Whether apply operation succeeded"),
  preview_id: z.string().describe("Preview ID applied"),
  applied_targets: z.array(z.string()).describe("Paths of files modified"),
  target: z.string().optional().describe("Primary target file path"),
  baseline_hash: z.string().nullable().optional().describe("Baseline hash"),
  message: z.string().describe("Apply result message"),
}).passthrough();

// ============================================================================
// 7. validate_configuration
// ============================================================================

export const ValidateConfigurationInputSchema = {
  expected_config: z
    .record(z.any())
    .optional()
    .describe("Expected configuration object to validate against actual host state"),
  preview_id: z
    .string()
    .optional()
    .describe("Preview ID to extract expected configuration from if omitted"),
  workspace: z
    .string()
    .optional()
    .describe("Workspace directory path (defaults to current working directory)"),
  host_id: z
    .string()
    .optional()
    .describe("Host identifier (optional, auto-detected from adapter if omitted)"),
};

export interface ValidateConfigurationResult {
  valid: boolean;
  workspace: string;
  message: string;
  details?: unknown;
}

export const ValidateConfigurationOutputSchema = z.object({
  valid: z.boolean().describe("Whether configuration is valid"),
  workspace: z.string().describe("Workspace path validated"),
  message: z.string().describe("Validation outcome message"),
  details: z.record(z.any()).optional().describe("Validation details"),
}).passthrough();

// ============================================================================
// 8. reset_profile
// ============================================================================

export const ResetProfileInputSchema = {
  scope: ScopeEnum.optional().describe("Configuration scope ('project' or 'global', defaults to 'project')"),
  workspace: z
    .string()
    .optional()
    .describe("Workspace directory path (defaults to current working directory)"),
  host_id: z
    .string()
    .optional()
    .describe("Host identifier (optional, auto-detected from adapter if omitted)"),
};

export interface ResetProfileResult {
  success: boolean;
  cleared: boolean;
  reset: boolean;
  host_id: string;
  scope: ScopeType;
  message: string;
}

export const ResetProfileOutputSchema = z.object({
  success: z.boolean().describe("Whether profile reset succeeded"),
  cleared: z.boolean().describe("Whether profile file was cleared"),
  reset: z.boolean().describe("Whether reset state is confirmed"),
  host_id: z.string().describe("Host identifier"),
  scope: ScopeEnum.describe("Scope reset"),
  message: z.string().describe("Reset outcome message"),
}).passthrough();

// ============================================================================
// Error Representations
// ============================================================================

export interface CompanionError {
  isError: true;
  message: string;
  tool?: ToolName;
  content: Array<{ type: "text"; text: string }>;
}

export function createToolErrorResponse(tool: ToolName, error: unknown): { isError: true; content: Array<{ type: "text"; text: string }> } {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: "text", text: `${tool} error: ${message}` }],
  };
}

// ============================================================================
// Machine-Readable Canonical Tool Contracts for Verification
// ============================================================================

export interface ParameterSpec {
  type: string;
  required: boolean;
  description?: string;
  enum?: string[];
}

export interface CanonicalToolContract {
  name: ToolName;
  description: string;
  parameters: Record<string, ParameterSpec>;
  requiredParameters: string[];
  responseProperties: Record<string, { type: string; required: boolean }>;
  requiredResponseProperties: string[];
}

export const CANONICAL_TOOL_CONTRACTS: Record<ToolName, CanonicalToolContract> = {
  get_setup_status: {
    name: "get_setup_status",
    description: "Check current Agent Config setup status, profile version, host/adapter IDs, and stale status.",
    parameters: {
      scope: { type: "string", required: false, enum: ["project", "global"] },
      workspace: { type: "string", required: false },
      host_id: { type: "string", required: false },
    },
    requiredParameters: [],
    responseProperties: {
      configured: { type: "boolean", required: true },
      protocol_version: { type: "number", required: true },
      profile_version: { type: "number", required: false },
      host_id: { type: "string", required: true },
      adapter_id: { type: "string", required: false },
      scope: { type: "string", required: false },
      stale: { type: "boolean", required: true },
      stale_reasons: { type: "array", required: true },
      companion_registered: { type: "boolean", required: false },
    },
    requiredResponseProperties: [
      "configured",
      "protocol_version",
      "host_id",
      "stale",
      "stale_reasons",
    ],
  },
  inspect_host: {
    name: "inspect_host",
    description: "Inspect host runtime capabilities, available models, supported effort values, and execution topology.",
    parameters: {
      workspace: { type: "string", required: false },
      host_id: { type: "string", required: false },
    },
    requiredParameters: [],
    responseProperties: {
      host_id: { type: "string", required: true },
      adapter_id: { type: "string", required: true },
      observed_at: { type: "string", required: true },
      available_models: { type: "array", required: true },
      supported_effort_values: { type: "array", required: true },
      capabilities: { type: "object", required: true },
    },
    requiredResponseProperties: [
      "host_id",
      "adapter_id",
      "observed_at",
      "available_models",
      "supported_effort_values",
      "capabilities",
    ],
  },
  get_profile: {
    name: "get_profile",
    description: "Retrieve the stored, user-confirmed Agent Config profile for the specified host and workspace.",
    parameters: {
      scope: { type: "string", required: false, enum: ["project", "global"] },
      workspace: { type: "string", required: false },
      host_id: { type: "string", required: false },
    },
    requiredParameters: [],
    responseProperties: {
      found: { type: "boolean", required: true },
      profile: { type: "object", required: false },
      message: { type: "string", required: false },
    },
    requiredResponseProperties: ["found"],
  },
  save_profile: {
    name: "save_profile",
    description: "Atomically validate and save a user-confirmed Agent Config profile.",
    parameters: {
      profile: { type: "object", required: true },
      workspace: { type: "string", required: false },
    },
    requiredParameters: ["profile"],
    responseProperties: {
      success: { type: "boolean", required: true },
      message: { type: "string", required: true },
      profile: { type: "object", required: true },
    },
    requiredResponseProperties: ["success", "message", "profile"],
  },
  preview_configuration: {
    name: "preview_configuration",
    description: "Generate a configuration preview (diff and mutation targets) before applying any changes.",
    parameters: {
      config: { type: "object", required: true },
      workspace: { type: "string", required: false },
      host_id: { type: "string", required: false },
    },
    requiredParameters: ["config"],
    responseProperties: {
      preview_id: { type: "string", required: true },
      preview_hash: { type: "string", required: true },
      diff: { type: "string", required: true },
      expires_at: { type: "string", required: true },
      target: { type: "string", required: true },
      baseline_hash: { type: "string", required: false },
      mutation_targets: { type: "array", required: true },
    },
    requiredResponseProperties: [
      "preview_id",
      "preview_hash",
      "diff",
      "expires_at",
      "target",
      "mutation_targets",
    ],
  },
  apply_configuration: {
    name: "apply_configuration",
    description: "Apply a previously previewed configuration using a valid preview ID.",
    parameters: {
      preview_id: { type: "string", required: true },
      workspace: { type: "string", required: false },
    },
    requiredParameters: ["preview_id"],
    responseProperties: {
      success: { type: "boolean", required: true },
      preview_id: { type: "string", required: true },
      applied_targets: { type: "array", required: true },
      target: { type: "string", required: false },
      baseline_hash: { type: "string", required: false },
      message: { type: "string", required: true },
    },
    requiredResponseProperties: [
      "success",
      "preview_id",
      "applied_targets",
      "message",
    ],
  },
  validate_configuration: {
    name: "validate_configuration",
    description: "Verify that actual host configuration matches expected configuration after apply.",
    parameters: {
      expected_config: { type: "object", required: false },
      preview_id: { type: "string", required: false },
      workspace: { type: "string", required: false },
      host_id: { type: "string", required: false },
    },
    requiredParameters: [],
    responseProperties: {
      valid: { type: "boolean", required: true },
      workspace: { type: "string", required: true },
      message: { type: "string", required: true },
      details: { type: "object", required: false },
    },
    requiredResponseProperties: ["valid", "workspace", "message"],
  },
  reset_profile: {
    name: "reset_profile",
    description: "Safely clear and remove the host-scoped profile for the specified workspace.",
    parameters: {
      scope: { type: "string", required: false, enum: ["project", "global"] },
      workspace: { type: "string", required: false },
      host_id: { type: "string", required: false },
    },
    requiredParameters: [],
    responseProperties: {
      success: { type: "boolean", required: true },
      cleared: { type: "boolean", required: true },
      reset: { type: "boolean", required: true },
      host_id: { type: "string", required: true },
      scope: { type: "string", required: true },
      message: { type: "string", required: true },
    },
    requiredResponseProperties: [
      "success",
      "cleared",
      "reset",
      "host_id",
      "scope",
      "message",
    ],
  },
};

// ============================================================================
// Companion Health Semantics & Evaluation
// ============================================================================

export interface CompanionToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, any>;
  parameters?: Record<string, any>;
  requiredParameters?: string[];
  outputSchema?: Record<string, any>;
  responseProperties?: Record<string, any>;
  requiredResponseProperties?: string[];
}

export interface CompanionHealthCheckParams {
  protocol_version?: number;
  tools?: CompanionToolDefinition[] | Record<string, CompanionToolDefinition>;
  reachable?: boolean;
}

export interface CompanionHealthCheckResult {
  healthy: boolean;
  status: "ready" | "stale" | "unsupported";
  protocol_version: number;
  missing_tools: string[];
  schema_errors: string[];
  reasons: string[];
}

/**
 * Strict Companion Health Evaluation:
 * - protocol_version === 1
 * - All 8 canonical tools present
 * - Tool input/output schemas match CANONICAL_TOOL_CONTRACTS
 * - Missing tools or schema mismatch marks status as 'stale' or 'unsupported', never 'ready'/'healthy'.
 */
export function evaluateCompanionHealth(
  params: CompanionHealthCheckParams
): CompanionHealthCheckResult {
  const protocolVersion = params.protocol_version ?? 0;
  const missingTools: string[] = [];
  const schemaErrors: string[] = [];
  const reasons: string[] = [];

  // 1. Protocol version check
  if (protocolVersion !== PROTOCOL_VERSION) {
    reasons.push(
      `Protocol version mismatch: expected ${PROTOCOL_VERSION}, got ${protocolVersion}`
    );
  }

  // 2. Reachability check
  if (params.reachable === false) {
    reasons.push("Companion process is unreachable or unresponsive");
  }

  // Normalize tools map
  const toolMap = new Map<string, CompanionToolDefinition>();
  if (Array.isArray(params.tools)) {
    for (const t of params.tools) {
      if (t && typeof t.name === "string") {
        toolMap.set(t.name, t);
      }
    }
  } else if (params.tools && typeof params.tools === "object") {
    for (const [key, val] of Object.entries(params.tools)) {
      if (val) {
        toolMap.set(val.name || key, val);
      }
    }
  }

  // 3. Verify all 8 canonical tools are present
  for (const toolName of TOOL_NAMES) {
    const tool = toolMap.get(toolName);
    if (!tool) {
      missingTools.push(toolName);
      continue;
    }

    // 4. Schema verification against CANONICAL_TOOL_CONTRACTS
    const canonical = CANONICAL_TOOL_CONTRACTS[toolName];
    if (!canonical) continue;

    // Verify inputSchema is present
    const hasInputSchema =
      (tool.inputSchema !== undefined && tool.inputSchema !== null) ||
      (tool.parameters !== undefined && tool.parameters !== null);

    if (!hasInputSchema) {
      schemaErrors.push(`Tool '${toolName}' is missing inputSchema`);
    }

    // Verify outputSchema is present (§4, §8)
    const hasOutputSchema =
      (tool.outputSchema !== undefined && tool.outputSchema !== null) ||
      (tool.responseProperties !== undefined && tool.responseProperties !== null);

    if (!hasOutputSchema) {
      schemaErrors.push(`Tool '${toolName}' is missing outputSchema`);
    }

    // A. Input parameters schema validation
    if (hasInputSchema) {
      const inputProps =
        tool.parameters ||
        (tool.inputSchema && typeof tool.inputSchema === "object"
          ? (tool.inputSchema as any).properties || tool.inputSchema
          : undefined);

      const requiredParams: string[] =
        tool.requiredParameters ||
        (tool.inputSchema && Array.isArray((tool.inputSchema as any).required)
          ? (tool.inputSchema as any).required
          : []);

      if (inputProps && typeof inputProps === "object") {
        for (const reqParam of canonical.requiredParameters) {
          const hasInProps = reqParam in inputProps;
          const hasInRequired = requiredParams.includes(reqParam);
          if (!hasInProps && !hasInRequired) {
            schemaErrors.push(
              `Tool '${toolName}' is missing required parameter '${reqParam}'`
            );
          }
        }

        for (const [pName, pSpec] of Object.entries(canonical.parameters)) {
          const toolParam = inputProps[pName];
          if (toolParam && typeof toolParam === "object") {
            const toolType = (toolParam as any).type;
            const normalizedCanonicalType = pSpec.type.toLowerCase();
            if (typeof toolType === "string") {
              const normalizedToolType = toolType.toLowerCase();
              if (
                normalizedToolType !== normalizedCanonicalType &&
                !(normalizedCanonicalType === "object" && normalizedToolType === "record")
              ) {
                schemaErrors.push(
                  `Tool '${toolName}' parameter '${pName}' has incompatible type: expected '${pSpec.type}', got '${toolType}'`
                );
              }
            } else if (Array.isArray(toolType)) {
              const types = toolType.map((t: any) => String(t).toLowerCase());
              if (
                !types.includes(normalizedCanonicalType) &&
                !(normalizedCanonicalType === "object" && types.includes("record"))
              ) {
                schemaErrors.push(
                  `Tool '${toolName}' parameter '${pName}' has incompatible type: expected '${pSpec.type}', got '${types.join("|")}'`
                );
              }
            }
          }
        }
      } else {
        schemaErrors.push(`Tool '${toolName}' inputSchema is not a valid schema object`);
      }
    }

    // B. Response properties schema validation
    if (hasOutputSchema) {
      const responseProps =
        tool.responseProperties ||
        (tool.outputSchema && typeof tool.outputSchema === "object"
          ? (tool.outputSchema as any).properties || tool.outputSchema
          : undefined);

      const requiredRespProps: string[] =
        tool.requiredResponseProperties ||
        (tool.outputSchema && Array.isArray((tool.outputSchema as any).required)
          ? (tool.outputSchema as any).required
          : []);

      if (responseProps && typeof responseProps === "object") {
        for (const reqProp of canonical.requiredResponseProperties) {
          const hasInProps = reqProp in responseProps;
          const hasInRequired = requiredRespProps.includes(reqProp);
          if (!hasInProps && !hasInRequired) {
            schemaErrors.push(
              `Tool '${toolName}' is missing required response property '${reqProp}'`
            );
          }
        }

        for (const [propName, propSpec] of Object.entries(canonical.responseProperties)) {
          const toolProp = responseProps[propName];
          if (toolProp && typeof toolProp === "object") {
            const toolType = (toolProp as any).type;
            const normalizedCanonicalType = propSpec.type.toLowerCase();
            if (typeof toolType === "string") {
              const normalizedToolType = toolType.toLowerCase();
              if (
                normalizedToolType !== normalizedCanonicalType &&
                !(normalizedCanonicalType === "object" && normalizedToolType === "record")
              ) {
                schemaErrors.push(
                  `Tool '${toolName}' response property '${propName}' has incompatible type: expected '${propSpec.type}', got '${toolType}'`
                );
              }
            } else if (Array.isArray(toolType)) {
              const types = toolType.map((t: any) => String(t).toLowerCase());
              if (
                !types.includes(normalizedCanonicalType) &&
                !(normalizedCanonicalType === "object" && types.includes("record"))
              ) {
                schemaErrors.push(
                  `Tool '${toolName}' response property '${propName}' has incompatible type: expected '${propSpec.type}', got '${types.join("|")}'`
                );
              }
            }
          }
        }
      } else {
        schemaErrors.push(`Tool '${toolName}' outputSchema is not a valid schema object`);
      }
    }
  }

  if (missingTools.length > 0) {
    reasons.push(`Missing canonical tools: ${missingTools.join(", ")}`);
  }
  if (schemaErrors.length > 0) {
    reasons.push(`Tool schema mismatches: ${schemaErrors.length} errors found`);
  }

  const healthy =
    reasons.length === 0 && missingTools.length === 0 && schemaErrors.length === 0 && params.reachable !== false;

  let status: "ready" | "stale" | "unsupported";
  if (healthy) {
    status = "ready";
  } else if (protocolVersion !== PROTOCOL_VERSION) {
    status = "unsupported";
  } else if (missingTools.length > 0 || schemaErrors.length > 0) {
    status = "stale";
  } else {
    status = "unsupported";
  }

  return {
    healthy,
    status,
    protocol_version: protocolVersion,
    missing_tools: missingTools,
    schema_errors: schemaErrors,
    reasons,
  };
}

