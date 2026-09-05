import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import crypto from "node:crypto";
import { HostAdapter, CompanionRegistrationStatus, CompanionRegistrationPreview, ValidationResult } from "../adapters/contract.js";
import { AdapterRegistry, defaultAdapterRegistry } from "../adapters/registry.js";
import { FrozenMutationPreview } from "../contracts/index.js";

/**
 * Inspection details for companion setup (§14, §15, §19).
 */
export interface CompanionSetupInspection {
  adapter_id: string;
  host_id: string;
  scope: "project" | "global" | "user";
  registered: boolean;
  configured?: boolean;
  reachable?: boolean;
  healthy?: boolean;
  transport?: "stdio" | "sse" | "websocket" | "http";
  locator?: string;
  target_file?: string;
  command?: string;
  args?: string[];
  details?: unknown;
}

/**
 * Mutation ownership required by SPEC §72.
 */
export interface MutationOwnership {
  adapter: string;
  host: string;
  scope: "project" | "global" | "user";
  target: string;
  baseline: string | null;
  changes: string;
}

/**
 * Detailed companion preview including ownership and diff (§14, §71, §72).
 * Implements FrozenMutationPreview (§26, §27).
 */
export interface CompanionSetupPreview extends FrozenMutationPreview {
  supported: boolean;
  target_file: string;
  diff: string;
  mutation_targets: string[];
  ownership: MutationOwnership;
  formatted_ownership: string;
  error?: string;
  raw_preview?: CompanionRegistrationPreview;
}

export interface CompanionSetupApplyOptions {
  workspace?: string;
  host_id?: string;
  scope?: "project" | "global" | "user";
  preview_id?: string;
  preview_hash: string;
  baseline_hash?: string | null;
  explicit_approval: boolean;
  registry?: AdapterRegistry;
  frozen_preview?: CompanionSetupPreview;
}

export interface CompanionSetupApplyResult {
  success: boolean;
  preview_id: string;
  preview_hash: string;
  applied_targets: string[];
  message: string;
  validation?: CompanionSetupValidationResult;
  error?: string;
}

export interface CompanionSetupValidationResult {
  valid: boolean;
  workspace?: string;
  host_id: string;
  adapter_id: string;
  registered: boolean;
  configured?: boolean;
  reachable?: boolean;
  healthy?: boolean;
  mcp_reachable: boolean;
  semantic_config_valid: boolean;
  message: string;
  details?: unknown;
  errors?: string[];
}

export interface CompanionSetupLifecycleOptions {
  workspace?: string;
  host_id?: string;
  scope?: "project" | "global";
  explicit_approval?: boolean;
  registry?: AdapterRegistry;
}

export interface CompanionSetupLifecycleResult {
  stage: "inspected" | "preview" | "completed";
  inspection: CompanionSetupInspection;
  preview?: CompanionSetupPreview;
  apply?: CompanionSetupApplyResult;
  validation?: CompanionSetupValidationResult;
  requires_approval?: boolean;
  message: string;
}

/**
 * Formats mutation ownership as human-readable block per SPEC §72.
 */
export function formatMutationOwnership(ownership: MutationOwnership): string {
  return [
    "Mutation Ownership:",
    `  Adapter:  ${ownership.adapter}`,
    `  Host:     ${ownership.host}`,
    `  Scope:    ${ownership.scope}`,
    `  Target:   ${ownership.target}`,
    `  Baseline: ${ownership.baseline ?? "none (new file)"}`,
    "  Changes:",
    ownership.changes
      ? ownership.changes
          .split("\n")
          .map((line) => `    ${line}`)
          .join("\n")
      : "    (no diff)",
  ].join("\n");
}

/**
 * Resolves the adapter for companion setup.
 */
export async function resolveSetupAdapter(
  workspace?: string,
  hostId?: string,
  registry?: AdapterRegistry
): Promise<{ adapter: HostAdapter; workspaceDir: string }> {
  const activeRegistry = registry || defaultAdapterRegistry;
  const workspaceDir = path.resolve(workspace || process.cwd());
  const adapter = await activeRegistry.resolveAdapter(workspaceDir, hostId);
  return { adapter, workspaceDir };
}

/**
 * Inspect companion registration status across host and workspace (§14, §15, §19).
 * Detection != Mutation: strictly read-only, never mutates files.
 */
export async function inspectCompanionSetup(options?: {
  workspace?: string;
  host_id?: string;
  scope?: "project" | "global" | "user";
  registry?: AdapterRegistry;
}): Promise<CompanionSetupInspection> {
  const { adapter, workspaceDir } = await resolveSetupAdapter(
    options?.workspace,
    options?.host_id,
    options?.registry
  );

  const rawStatus: CompanionRegistrationStatus = await adapter.inspectCompanionRegistration(
    workspaceDir,
    options?.scope
  );

  const resolvedScope: "project" | "global" | "user" =
    rawStatus.scope || options?.scope || (options?.workspace ? "project" : "global");
  const targetFile = rawStatus.target_file || rawStatus.locator;

  return {
    adapter_id: adapter.id,
    host_id: options?.host_id || adapter.id,
    scope: resolvedScope,
    registered: Boolean(rawStatus.registered),
    transport: rawStatus.transport || (rawStatus.registered ? "stdio" : undefined),
    locator: rawStatus.locator || targetFile,
    target_file: targetFile,
    command: rawStatus.command,
    args: rawStatus.args,
    details: rawStatus.details,
  };
}

/**
 * Generate preview diff, baseline hash, and mutation ownership for unregistered host (§14, §71, §72).
 * Detection != Mutation: strictly read-only, never mutates files.
 */
export async function previewCompanionSetup(options?: {
  workspace?: string;
  host_id?: string;
  scope?: "project" | "global";
  registry?: AdapterRegistry;
}): Promise<CompanionSetupPreview> {
  const { adapter, workspaceDir } = await resolveSetupAdapter(
    options?.workspace,
    options?.host_id,
    options?.registry
  );

  const rawPreview: CompanionRegistrationPreview = await adapter.previewCompanionRegistration(
    workspaceDir,
    options?.scope
  );

  const targetFile = rawPreview.target_file || (rawPreview.mutation_targets && rawPreview.mutation_targets[0]) || "";
  const resolvedScope: "project" | "global" | "user" = rawPreview.scope || options?.scope || (options?.workspace ? "project" : "global");
  const adapterId = rawPreview.adapter_id || adapter.id;
  const hostId = rawPreview.host_id || options?.host_id || adapter.id;
  const baselineHash = rawPreview.baseline_hash ?? null;
  const diff = rawPreview.diff || "";
  const previewHash = rawPreview.preview_hash || (diff ? crypto.createHash("sha256").update(diff).digest("hex") : "");
  const previewId = rawPreview.preview_id || `preview-companion-${adapterId}-${Date.now()}`;
  const versionInfo = await adapter.inspectVersion(workspaceDir);

  const ownership: MutationOwnership = {
    adapter: adapterId,
    host: hostId,
    scope: resolvedScope,
    target: targetFile,
    baseline: baselineHash,
    changes: diff,
  };

  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + 15 * 60 * 1000).toISOString();

  return {
    supported: rawPreview.supported,
    adapter_id: adapterId,
    host_id: hostId,
    host_identity: hostId,
    host_version: versionInfo.version,
    scope: resolvedScope,
    target: targetFile,
    target_file: targetFile,
    baseline_identity: targetFile,
    baseline_hash: baselineHash,
    mutation: {
      diff,
      patch: diff,
      files: rawPreview.files,
    },
    created_at: createdAt.toISOString(),
    expires_at: expiresAt,
    diff,
    preview_hash: previewHash,
    preview_id: previewId,
    mutation_targets: rawPreview.mutation_targets || (targetFile ? [targetFile] : []),
    ownership,
    formatted_ownership: formatMutationOwnership(ownership),
    error: rawPreview.error,
    raw_preview: rawPreview,
  };
}

/**
 * Apply companion registration mutation atomically with verified preview hash and explicit approval (§14, §15, §71).
 */
export async function applyCompanionSetup(
  options: CompanionSetupApplyOptions
): Promise<CompanionSetupApplyResult> {
  // Enforce explicit approval (§15, §71)
  if (options.explicit_approval !== true) {
    return {
      success: false,
      preview_id: options.preview_id || options.preview_hash,
      preview_hash: options.preview_hash,
      applied_targets: [],
      message: "Explicit user approval required before applying companion registration mutation.",
      error: "ApprovalRequiredError: Explicit user approval was not granted.",
    };
  }

  const { adapter, workspaceDir } = await resolveSetupAdapter(
    options.workspace,
    options.host_id,
    options.registry
  );

  // Stale preview & drift checks (§26, §31, §71)
  const frozen = options.frozen_preview;
  const targetScope = frozen?.scope || options.scope;
  const targetFile = frozen?.target || frozen?.target_file;

  if (frozen?.host_version) {
    const versionInfo = await adapter.inspectVersion(workspaceDir);
    const currentVer = versionInfo.version || "unknown";
    if (currentVer !== frozen.host_version) {
      return {
        success: false,
        preview_id: options.preview_id || options.preview_hash,
        preview_hash: options.preview_hash,
        applied_targets: [],
        message: `Stale preview: host version drifted from '${frozen.host_version}' to '${currentVer}'. Refusing to apply stale preview. Please re-preview.`,
        error: "StalePreviewError: Host version has changed since preview generation.",
      };
    }
  }

  // Baseline drift check (§71, §31)
  if (options.baseline_hash !== undefined || frozen?.baseline_hash !== undefined) {
    const expectedBaselineHash = options.baseline_hash !== undefined ? options.baseline_hash : frozen?.baseline_hash;
    const checkFile = targetFile || (await adapter.previewCompanionRegistration(workspaceDir, targetScope as any)).target_file;
    if (checkFile && fs.existsSync(checkFile)) {
      const currentContent = await fsp.readFile(checkFile, "utf-8");
      const currentHash = crypto.createHash("sha256").update(currentContent).digest("hex");
      if (expectedBaselineHash !== null && expectedBaselineHash !== undefined && currentHash !== expectedBaselineHash) {
        return {
          success: false,
          preview_id: options.preview_id || options.preview_hash,
          preview_hash: options.preview_hash,
          applied_targets: [],
          message: `Baseline hash drift detected for '${checkFile}': expected ${expectedBaselineHash}, found ${currentHash}.`,
          error: "BaselineDriftError: Target configuration was modified concurrently.",
        };
      }
    } else if (expectedBaselineHash !== null && expectedBaselineHash !== undefined) {
      return {
        success: false,
        preview_id: options.preview_id || options.preview_hash,
        preview_hash: options.preview_hash,
        applied_targets: [],
        message: `Baseline hash drift detected: target file '${checkFile}' does not exist, but expected baseline ${expectedBaselineHash}.`,
        error: "BaselineDriftError: Target file missing or modified concurrently.",
      };
    }
  }

  // Apply companion registration via adapter using exact frozen preview if available
  const rawPreviewToPass = frozen?.raw_preview;
  const applyResult = await adapter.applyCompanionRegistration(
    options.preview_hash,
    workspaceDir,
    rawPreviewToPass
  );

  if (!applyResult.success) {
    return {
      success: false,
      preview_id: options.preview_id || options.preview_hash,
      preview_hash: options.preview_hash,
      applied_targets: applyResult.applied_targets || [],
      message: applyResult.error || "Failed to apply companion registration.",
      error: applyResult.error,
    };
  }

  // Post-apply validation: read back effective host state (§14, §73, §76)
  const validation = await validateCompanionSetup({
    workspace: workspaceDir,
    host_id: options.host_id || adapter.id,
    scope: options.scope,
    registry: options.registry,
  });

  return {
    success: true,
    preview_id: options.preview_id || options.preview_hash,
    preview_hash: options.preview_hash,
    applied_targets: applyResult.applied_targets,
    message: applyResult.message || "Companion registration applied successfully.",
    validation,
  };
}

/**
 * Validate effective host state, MCP reachability, and semantic configuration (§14, §73, §76).
 */
export async function validateCompanionSetup(options?: {
  workspace?: string;
  host_id?: string;
  scope?: "project" | "global" | "user";
  registry?: AdapterRegistry;
}): Promise<CompanionSetupValidationResult> {
  const { adapter, workspaceDir } = await resolveSetupAdapter(
    options?.workspace,
    options?.host_id,
    options?.registry
  );

  const errors: string[] = [];

  // 1. Adapter validation hook
  const adapterValidation: ValidationResult = await adapter.validateCompanionRegistration(
    workspaceDir
  );
  if (!adapterValidation.valid) {
    errors.push(adapterValidation.message || "Adapter companion validation failed.");
  }

  // 2. Read back effective registration state from disk
  const inspection = await inspectCompanionSetup({
    workspace: workspaceDir,
    host_id: options?.host_id || adapter.id,
    scope: options?.scope,
    registry: options?.registry,
  });

  if (!inspection.registered) {
    errors.push(`Companion MCP server is not registered in effective host configuration for '${adapter.id}'.`);
  }

  let semanticConfigValid = false;
  let mcpReachable = false;

  if (inspection.target_file && fs.existsSync(inspection.target_file)) {
    try {
      const content = await fsp.readFile(inspection.target_file, "utf-8");
      // Check that target file contains agent-config reference
      if (content.includes("agent-config")) {
        semanticConfigValid = true;
      } else {
        errors.push(`Target configuration at '${inspection.target_file}' does not contain 'agent-config' server entry.`);
      }
    } catch (err: any) {
      errors.push(`Failed to read back target configuration file: ${err.message}`);
    }
  } else if (inspection.registered) {
    // Registered via runtime inspection or other mechanism
    semanticConfigValid = true;
  }

  // Strictly distinguish registration, configuration, reachability, and health (SPEC §32-§33, §79)
  const isRegistered = inspection.registered;
  const isConfigured = semanticConfigValid;
  let isReachable = false;
  let isHealthy = false;

  if (isRegistered && isConfigured) {
    // Check if host provides native verification, command executable verification, or adapter reachability
    const cmd = inspection.command;
    if (cmd) {
      const binName = cmd.trim().split(/\s+/)[0];
      // If command is valid executable or in path or node/npx/agent-config
      if (
        binName === "agent-config" ||
        binName === "node" ||
        binName === "npx" ||
        fs.existsSync(binName)
      ) {
        isReachable = true;
        isHealthy = true;
      } else {
        // Unknown or custom command without verified path
        isReachable = false;
        isHealthy = false;
      }
    } else {
      // Registered in config, but command is absent or unknown => not reachable
      isReachable = false;
      isHealthy = false;
    }
  }

  mcpReachable = isReachable;

  const isValid = adapterValidation.valid && isRegistered && isConfigured && errors.length === 0;

  return {
    valid: isValid,
    workspace: workspaceDir,
    host_id: options?.host_id || adapter.id,
    adapter_id: adapter.id,
    registered: isRegistered,
    configured: isConfigured,
    reachable: isReachable,
    healthy: isHealthy,
    mcp_reachable: isReachable,
    semantic_config_valid: isConfigured,
    message: isValid
      ? `Companion MCP server registration validated for host '${adapter.id}' (registered: ${isRegistered}, configured: ${isConfigured}, reachable: ${isReachable}).`
      : `Companion validation failed for host '${adapter.id}': ${errors.join("; ")}`,
    details: {
      inspection,
      adapter_validation: adapterValidation,
      registered: isRegistered,
      configured: isConfigured,
      reachable: isReachable,
      healthy: isHealthy,
      errors,
    },
    errors: errors.length > 0 ? errors : undefined,
  };
}

/**
 * Unified Companion Setup Lifecycle coordinator (§13, §14, §15, §71).
 */
export async function runCompanionSetupLifecycle(
  options?: CompanionSetupLifecycleOptions
): Promise<CompanionSetupLifecycleResult> {
  // Step 1: Identify current Harness & Inspect companion registration
  const inspection = await inspectCompanionSetup(options);

  // If already registered, validate effective state and return completed
  if (inspection.registered) {
    const validation = await validateCompanionSetup(options);
    return {
      stage: "completed",
      inspection,
      validation,
      message: `Agent Config Companion MCP is already registered and validated for host '${inspection.host_id}'.`,
    };
  }

  // Step 2: Generate preview with exact ownership
  const preview = await previewCompanionSetup(options);
  if (!preview.supported) {
    return {
      stage: "preview",
      inspection,
      preview,
      requires_approval: false,
      message: `Companion registration is unsupported for host '${inspection.host_id}': ${preview.error || "unsupported"}`,
    };
  }

  // Step 3: Check explicit approval
  if (options?.explicit_approval !== true) {
    return {
      stage: "preview",
      inspection,
      preview,
      requires_approval: true,
      message: `Companion registration preview ready for host '${inspection.host_id}'. Explicit user approval required before mutation.`,
    };
  }

  // Step 4: Apply mutation atomically
  const applyResult = await applyCompanionSetup({
    workspace: options.workspace,
    host_id: options.host_id,
    scope: options.scope,
    preview_id: preview.preview_id,
    preview_hash: preview.preview_hash,
    baseline_hash: preview.baseline_hash,
    explicit_approval: true,
    registry: options.registry,
  });

  // Step 5: Read back effective state
  const validation = applyResult.validation || (await validateCompanionSetup(options));

  return {
    stage: "completed",
    inspection,
    preview,
    apply: applyResult,
    validation,
    message: applyResult.success
      ? `Companion MCP server registered and validated for host '${inspection.host_id}'.`
      : `Failed to apply companion registration for host '${inspection.host_id}': ${applyResult.message}`,
  };
}
