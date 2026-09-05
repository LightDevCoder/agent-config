import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { HostAdapter, CompanionRegistrationStatus, CompanionRegistrationPreview, ValidationResult } from "../adapters/contract.js";
import { AdapterRegistry, defaultAdapterRegistry } from "../adapters/registry.js";
import {
  FrozenMutationPreview,
  MutationOperation,
  CANONICAL_TOOL_CONTRACTS,
  evaluateCompanionHealth,
  CompanionToolDefinition,
  CompanionHealthCheckParams,
  CompanionHealthCheckResult,
  SUPPORTED_PROTOCOL_VERSIONS,
  LATEST_PROTOCOL_VERSION,
} from "../contracts/index.js";

export {
  CANONICAL_TOOL_CONTRACTS,
  evaluateCompanionHealth,
  CompanionToolDefinition,
  CompanionHealthCheckParams,
  CompanionHealthCheckResult,
  SUPPORTED_PROTOCOL_VERSIONS,
  LATEST_PROTOCOL_VERSION,
};

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
  protocol_version?: number;
  tools?: CompanionToolDefinition[] | Record<string, CompanionToolDefinition>;
  reachable?: boolean;
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
  health?: CompanionHealthCheckResult;
}

export interface CompanionSetupValidationOptions {
  workspace?: string;
  host_id?: string;
  scope?: "project" | "global" | "user";
  registry?: AdapterRegistry;
  protocol_version?: number;
  mcp_protocol_version?: string;
  tools?: CompanionToolDefinition[] | Record<string, CompanionToolDefinition>;
  reachable?: boolean;
}

export interface CompanionSetupLifecycleOptions {
  workspace?: string;
  host_id?: string;
  scope?: "project" | "global";
  explicit_approval?: boolean;
  registry?: AdapterRegistry;
  protocol_version?: number;
  mcp_protocol_version?: string;
  tools?: CompanionToolDefinition[] | Record<string, CompanionToolDefinition>;
  reachable?: boolean;
}

export interface CompanionSetupLifecycleResult {
  stage: "inspected" | "preview" | "completed" | "repair_required";
  success?: boolean;
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

  const operations: MutationOperation[] = [];
  if (rawPreview.files && rawPreview.files.length > 0) {
    for (const file of rawPreview.files) {
      operations.push({
        type: "file",
        target: file.path,
        action: baselineHash === null ? "create" : "update",
        diff,
        content: file.content,
        baseline_hash: baselineHash,
        reversible: true,
      });
    }
  } else if (targetFile) {
    operations.push({
      type: "file",
      target: targetFile,
      action: baselineHash === null ? "create" : "update",
      diff,
      baseline_hash: baselineHash,
      reversible: true,
    });
  }

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
    operations,
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

  // Multi-operation preflight: reversibility & baseline verification across all operations (§26, §27)
  if (frozen?.operations && frozen.operations.length > 0) {
    for (const op of frozen.operations) {
      if (op.reversible === false) {
        return {
          success: false,
          preview_id: options.preview_id || options.preview_hash,
          preview_hash: options.preview_hash,
          applied_targets: [],
          message: `Preflight failed: Operation targeting '${op.type === "file" ? op.target : op.description}' is marked non-reversible. Reversible safety semantics required.`,
          error: "PreflightError: Non-reversible operation rejected.",
        };
      }
      if (op.type === "file" && op.baseline_hash !== undefined) {
        const fileExists = fs.existsSync(op.target);
        const curHash = fileExists
          ? crypto.createHash("sha256").update(await fsp.readFile(op.target, "utf-8")).digest("hex")
          : null;
        if (curHash !== op.baseline_hash) {
          return {
            success: false,
            preview_id: options.preview_id || options.preview_hash,
            preview_hash: options.preview_hash,
            applied_targets: [],
            message: `Baseline hash drift detected for '${op.target}': expected ${op.baseline_hash}, found ${curHash}.`,
            error: "BaselineDriftError: Target configuration was modified concurrently.",
          };
        }
      }
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
    protocol_version: options.protocol_version,
    tools: options.tools,
    reachable: options.reachable,
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

function findExecutable(command: string): string | null {
  if (command === "node" || command === "nodejs") {
    return process.execPath;
  }
  if (path.isAbsolute(command)) {
    return fs.existsSync(command) ? command : null;
  }
  if (command.includes(path.sep)) {
    const resolved = path.resolve(command);
    return fs.existsSync(resolved) ? resolved : null;
  }
  const envPath = process.env.PATH || "";
  const dirs = envPath.split(path.delimiter);
  for (const dir of dirs) {
    const candidate = path.join(dir, command);
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // ignore
    }
  }
  return null;
}

async function probeCompanionMcp(
  commandPath: string,
  args: string[] = [],
  timeoutMs: number = 3000
): Promise<{
  reachable: boolean;
  mcp_protocol_version?: string;
  mcp_transport_error?: string;
  protocol_version?: number;
  tools?: CompanionToolDefinition[];
}> {
  return new Promise((resolve) => {
    let resolved = false;
    let proc: any;
    let probedToolsList: CompanionToolDefinition[] | undefined;
    let probedMcpProtocol: string | undefined;
    let probedMcpTransportError: string | undefined;

    const finish = (result: {
      reachable: boolean;
      mcp_protocol_version?: string;
      mcp_transport_error?: string;
      protocol_version?: number;
      tools?: CompanionToolDefinition[];
    }) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        if (proc) {
          try {
            proc.kill();
          } catch {
            // ignore
          }
        }
        resolve(result);
      }
    };

    const timer = setTimeout(() => {
      finish({ reachable: false });
    }, timeoutMs);

    try {
      proc = spawn(commandPath, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
      });
    } catch {
      finish({ reachable: false });
      return;
    }

    proc.on("error", () => {
      finish({ reachable: false });
    });

    proc.on("close", () => {
      if (!resolved) {
        finish({ reachable: false });
      }
    });

    let buffer = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf-8");
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line.trim());
          if (msg.id === 1) {
            let mcpTransportErr: string | undefined;
            if (msg.error) {
              mcpTransportErr = `MCP transport protocol mismatch: initialize error ${msg.error.message || JSON.stringify(msg.error)}`;
            } else if (!msg.result) {
              mcpTransportErr = "missing MCP transport initialize result";
            } else {
              const rawTransportVersion = msg.result.protocolVersion;
              // Check missing protocolVersion (SPEC §6)
              if (rawTransportVersion === undefined) {
                mcpTransportErr = "missing MCP transport protocolVersion";
              } else if (
                typeof rawTransportVersion !== "string" ||
                !rawTransportVersion.trim()
              ) {
                // Check invalid protocolVersion (SPEC §7: null, number, empty string, malformed value)
                probedMcpProtocol = rawTransportVersion === null ? "null" : String(rawTransportVersion);
                mcpTransportErr = `MCP transport protocol mismatch: expected supported ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")}, received ${rawTransportVersion === null ? "null" : typeof rawTransportVersion === "number" ? rawTransportVersion : JSON.stringify(rawTransportVersion)}`;
              } else {
                probedMcpProtocol = rawTransportVersion.trim();
                // Check unsupported protocolVersion (SPEC §5)
                if (!SUPPORTED_PROTOCOL_VERSIONS.includes(probedMcpProtocol)) {
                  mcpTransportErr = `MCP transport protocol mismatch: expected supported ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")}, received ${probedMcpProtocol}`;
                }
              }
            }

            if (mcpTransportErr) {
              probedMcpTransportError = mcpTransportErr;
            }

            // Continue to read tools and get_setup_status for full diagnostics (SPEC §5, §9, §13)
            const initNotice =
              JSON.stringify({
                jsonrpc: "2.0",
                method: "notifications/initialized",
                params: {},
              }) + "\n";
            const listReq =
              JSON.stringify({
                jsonrpc: "2.0",
                id: 2,
                method: "tools/list",
                params: {},
              }) + "\n";
            try {
              proc.stdin.write(initNotice);
              proc.stdin.write(listReq);
            } catch {
              finish({
                reachable: true,
                mcp_protocol_version: probedMcpProtocol,
                mcp_transport_error: probedMcpTransportError,
              });
            }
          } else if (msg.id === 2) {
            if (msg.error) {
              finish({
                reachable: true,
                mcp_protocol_version: probedMcpProtocol,
                mcp_transport_error: probedMcpTransportError,
                protocol_version: undefined,
                tools: [],
              });
              return;
            }
            const rawTools = msg.result?.tools || [];
            const tools: CompanionToolDefinition[] = rawTools.map((t: any) => ({
              name: t.name,
              inputSchema: t.inputSchema,
              outputSchema: t.outputSchema,
            }));
            probedToolsList = tools;

            // Check if canonical get_setup_status tool exists
            const hasGetSetupStatus = tools.some((t) => t.name === "get_setup_status");
            if (!hasGetSetupStatus) {
              // Missing get_setup_status: cannot probe contract version
              finish({
                reachable: true,
                mcp_protocol_version: probedMcpProtocol,
                mcp_transport_error: probedMcpTransportError,
                protocol_version: undefined,
                tools,
              });
              return;
            }

            // Probe actual Agent Config contract version from live companion via get_setup_status (SPEC §6, §7)
            const callReq =
              JSON.stringify({
                jsonrpc: "2.0",
                id: 3,
                method: "tools/call",
                params: {
                  name: "get_setup_status",
                  arguments: {},
                },
              }) + "\n";
            try {
              proc.stdin.write(callReq);
            } catch {
              finish({
                reachable: true,
                mcp_protocol_version: probedMcpProtocol,
                mcp_transport_error: probedMcpTransportError,
                protocol_version: undefined,
                tools,
              });
            }
          } else if (msg.id === 3) {
            let probedProtocol: number | undefined;
            if (msg.result) {
              if (typeof msg.result.protocol_version === "number") {
                probedProtocol = msg.result.protocol_version;
              } else if (Array.isArray(msg.result.content)) {
                for (const item of msg.result.content) {
                  if (item?.type === "text" && typeof item.text === "string") {
                    try {
                      const parsed = JSON.parse(item.text);
                      if (typeof parsed?.protocol_version === "number") {
                        probedProtocol = parsed.protocol_version;
                        break;
                      }
                    } catch {
                      // ignore non-json text
                    }
                  }
                }
              } else if (typeof msg.result.structuredContent?.protocol_version === "number") {
                probedProtocol = msg.result.structuredContent.protocol_version;
              }
            }
            finish({
              reachable: true,
              mcp_protocol_version: probedMcpProtocol,
              mcp_transport_error: probedMcpTransportError,
              protocol_version: probedProtocol,
              tools: probedToolsList,
            });
            return;
          }
        } catch {
          // ignore non-JSON line
        }
      }
    });

    const initReq =
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "agent-config-health-checker", version: "0.1.0" },
        },
      }) + "\n";

    try {
      proc.stdin.write(initReq);
    } catch {
      finish({ reachable: false });
    }
  });
}

/**
 * Validate effective host state, MCP reachability, and semantic configuration (§14, §73, §76).
 */
export async function validateCompanionSetup(
  options?: CompanionSetupValidationOptions
): Promise<CompanionSetupValidationResult> {
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

  // Strictly distinguish registration, configuration, reachability, and health (SPEC §32-§33, §79, §5, §6)
  const isRegistered = inspection.registered;
  const isConfigured = semanticConfigValid;
  let isReachable = false;
  let isHealthy = false;
  let probedTools: CompanionToolDefinition[] | undefined;
  let probedProtocol: number | undefined;
  let probedMcpProtocol: string | undefined;
  let probedMcpTransportError: string | undefined;

  if (options?.reachable !== undefined) {
    isReachable = options.reachable;
  } else if (!isRegistered || !isConfigured) {
    isReachable = false;
  } else if (options?.tools !== undefined) {
    // Explicitly provided tools (testing or simulated harness)
    isReachable = true;
  } else {
    // Real probe of configured command
    const cmd = inspection.command;
    if (cmd) {
      const binName = cmd.trim().split(/\s+/)[0];
      const execPath = findExecutable(binName);
      if (!execPath) {
        isReachable = false;
      } else {
        const probe = await probeCompanionMcp(
          execPath,
          inspection.args || ["serve"]
        );
        isReachable = probe.reachable;
        if (probe.mcp_protocol_version !== undefined) {
          probedMcpProtocol = probe.mcp_protocol_version;
        }
        if (probe.mcp_transport_error !== undefined) {
          probedMcpTransportError = probe.mcp_transport_error;
        }
        if (probe.tools) {
          probedTools = probe.tools;
        }
        if (probe.protocol_version !== undefined) {
          probedProtocol = probe.protocol_version;
        }
      }
    } else {
      isReachable = false;
    }
  }

  // Evaluate companion health strictly against all canonical invariants (§5, §6)
  const toolsToEvaluate =
    options?.tools !== undefined ? options.tools : (probedTools ?? []);
  const protocolToEvaluate =
    options?.protocol_version !== undefined
      ? options.protocol_version
      : options?.tools !== undefined
        ? 1
        : (probedProtocol ?? 0);
  const mcpProtocolToEvaluate =
    options?.mcp_protocol_version !== undefined
      ? options.mcp_protocol_version
      : probedMcpProtocol;

  const healthResult = evaluateCompanionHealth({
    protocol_version: protocolToEvaluate,
    mcp_protocol_version: mcpProtocolToEvaluate,
    mcp_transport_error: probedMcpTransportError,
    tools: toolsToEvaluate,
    reachable: isReachable,
  });

  isHealthy = healthResult.healthy;

  // If explicit tools, protocol, reachable, or mcp_protocol_version options were supplied, health failures invalidate the validation result
  if (
    options?.tools !== undefined ||
    options?.protocol_version !== undefined ||
    options?.reachable !== undefined ||
    options?.mcp_protocol_version !== undefined
  ) {
    if (!healthResult.healthy) {
      errors.push(...healthResult.reasons, ...healthResult.schema_errors);
    }
  }

  mcpReachable = isReachable;

  const isValid =
    adapterValidation.valid &&
    isRegistered &&
    isConfigured &&
    errors.length === 0;

  let message = "";
  if (!isValid) {
    message = `Companion registration failed for host '${adapter.id}': ${errors.join("; ")}`;
  } else if (!isHealthy) {
    message = `Companion MCP server registered for host '${adapter.id}', but health check failed: ${healthResult.reasons.concat(healthResult.schema_errors).join("; ")}`;
  } else {
    message = `Companion MCP server registration validated and healthy for host '${adapter.id}' (registered: ${isRegistered}, configured: ${isConfigured}, reachable: ${isReachable}, healthy: ${isHealthy}).`;
  }

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
    message,
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
    health: healthResult,
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

  // If already registered, validate effective state and return completed only if healthy
  if (inspection.registered) {
    const validation = await validateCompanionSetup(options);
    if (validation.healthy) {
      return {
        stage: "completed",
        success: true,
        inspection,
        validation,
        message: `Agent Config Companion MCP is already registered and validated for host '${inspection.host_id}'.`,
      };
    } else {
      return {
        stage: "repair_required",
        success: false,
        inspection,
        validation,
        message: `Agent Config Companion MCP is registered for host '${inspection.host_id}', but companion is unhealthy: ${validation.message}`,
      };
    }
  }

  // Step 2: Generate preview with exact ownership
  const preview = await previewCompanionSetup(options);
  if (!preview.supported) {
    return {
      stage: "preview",
      success: false,
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
      success: false,
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
    protocol_version: options?.protocol_version,
    tools: options?.tools,
    reachable: options?.reachable,
  });

  // Step 5: Read back effective state and verify health (SPEC §10, §14)
  const validation = applyResult.validation || (await validateCompanionSetup(options));
  const isHealthy = validation.healthy;

  if (applyResult.success && isHealthy) {
    return {
      stage: "completed",
      success: true,
      inspection,
      preview,
      apply: applyResult,
      validation,
      message: `Companion MCP server registered and validated for host '${inspection.host_id}'.`,
    };
  } else {
    const errorMsg = !applyResult.success
      ? `Failed to apply companion registration for host '${inspection.host_id}': ${applyResult.message}`
      : `Companion registration applied for host '${inspection.host_id}', but health validation failed: ${validation.message}`;
    return {
      stage: "repair_required",
      success: false,
      inspection,
      preview,
      apply: applyResult,
      validation,
      message: errorMsg,
    };
  }
}
