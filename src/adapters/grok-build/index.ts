import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import childProcess from "node:child_process";
import {
  HostAdapter,
  HostCapabilities,
  HostModel,
  RenderedConfiguration,
  RenderedFile,
  ApplyResult,
  ValidationResult,
  HostVersionInfo,
  HostReasoningOptions,
  TopologyCapabilities,
  CompanionRegistrationStatus,
  CompanionRegistrationPreview,
  ResolvedReasoningPolicy,
  CapabilityState,
  HostModelEvidence,
} from "../contract.js";
import { ExecutionConfig, AgentProfile } from "../../profile/schema.js";
import { createUnifiedDiff } from "../diff.js";

/**
 * Output shape from machine-readable runtime inspection (`grok inspect --json` or equivalent) (§44, §45).
 */
export interface GrokInspectOutput {
  version?: string;
  model?: string;
  worker_model?: string;
  models?: Array<string | { id: string; label?: string; state?: CapabilityState }>;
  supported_models?: string[];
  reasoning_effort?: string;
  supported_effort_values?: string[];
  subagents?: {
    enabled?: boolean;
    parallel?: boolean;
    worktrees?: boolean;
    agent_specific_model?: boolean;
    agents?: Array<{ name: string; model?: string; reasoning_effort?: string }>;
  };
  parallelism?: {
    enabled?: boolean;
    max_concurrency?: number;
  };
  worktree_isolation?: boolean;
  mcp?: {
    servers?: Record<string, { command: string; args?: string[] }>;
  };
  mcp_servers?: Record<string, { command: string; args?: string[] }>;
  policy?: {
    deny_mutation?: boolean;
    locked?: boolean;
    locked_keys?: string[];
    enforce_model?: string;
    allowed_models?: string[];
  };
}

/**
 * Parsed TOML document structure.
 */
export type ParsedToml = Record<string, any>;

/**
 * Grok Build config layering representations (§46).
 * Precedence: Policy > Managed > Project > User.
 * Effective config is in-memory only and NEVER flattened to ~/.grok/config.toml!
 */
export interface GrokLayeredConfig {
  policyConfig?: ParsedToml;
  managedConfig?: ParsedToml;
  projectConfig?: ParsedToml;
  userConfig?: ParsedToml;
  effectiveConfig: ParsedToml;
  lockedKeys: Set<string>;
  policyFiles: string[];
  managedFiles: string[];
  projectFile?: string;
  userFile?: string;
}

/**
 * Parses simple TOML format supporting tables, nested keys, strings, booleans, numbers, and arrays.
 */
export function parseToml(content: string): ParsedToml {
  const result: ParsedToml = {};
  let currentTable = result;

  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const commentIdx = rawLine.indexOf("#");
    const line = (commentIdx >= 0 ? rawLine.slice(0, commentIdx) : rawLine).trim();
    if (!line) continue;

    // Table header: [table] or [table.subtable]
    const tableMatch = line.match(/^\[([A-Za-z0-9_.-]+)\]$/);
    if (tableMatch) {
      const parts = tableMatch[1].split(".");
      let cur = result;
      for (const part of parts) {
        if (!cur[part] || typeof cur[part] !== "object" || Array.isArray(cur[part])) {
          cur[part] = {};
        }
        cur = cur[part];
      }
      currentTable = cur;
      continue;
    }

    // Key-value pair: key = value
    const kvMatch = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/);
    if (!kvMatch) {
      if (line.startsWith("[") && !tableMatch) {
        throw new Error(`Malformed TOML table header: ${line}`);
      }
      continue;
    }

    const key = kvMatch[1].trim();
    const rawVal = kvMatch[2].trim();

    currentTable[key] = parseTomlValue(rawVal);
  }

  return result;
}

function parseTomlValue(valStr: string): any {
  if (valStr.startsWith('"') && valStr.endsWith('"')) {
    return valStr.slice(1, -1).replace(/\\"/g, '"');
  }
  if (valStr.startsWith("'") && valStr.endsWith("'")) {
    return valStr.slice(1, -1);
  }
  if (valStr === "true") return true;
  if (valStr === "false") return false;
  if (/^-?\d+$/.test(valStr)) return parseInt(valStr, 10);
  if (/^-?\d+\.\d+$/.test(valStr)) return parseFloat(valStr);
  if (valStr.startsWith("[") && valStr.endsWith("]")) {
    const inner = valStr.slice(1, -1).trim();
    if (!inner) return [];
    return inner
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
      .map((item) => parseTomlValue(item));
  }
  if (valStr === "{}") return {};
  return valStr;
}

/**
 * Dedicated Grok Build Native Host Adapter (§44, §45, §46, §47, §48).
 */
export class GrokBuildAdapter implements HostAdapter {
  readonly id = "grok-build";
  readonly name = "Grok Build Adapter";

  /**
   * Detects active Grok Build runtime environment from process environment or ancestry (§44).
   */
  hasActiveRuntimeContext(_workspaceRoot?: string): boolean {
    if (
      process.env.GROK_BUILD === "1" ||
      process.env.GROK_BUILD === "true" ||
      (process.env.GROK_HOME && process.env.GROK_HOME !== "undefined") ||
      (process.env.GROK_SESSION && process.env.GROK_SESSION !== "undefined") ||
      (process.env.GROK_SESSION_ID && process.env.GROK_SESSION_ID !== "undefined") ||
      (process.env.GROK_PROJECT_DIR && process.env.GROK_PROJECT_DIR !== "undefined") ||
      (process.env.GROK_CONFIG_DIR && process.env.GROK_CONFIG_DIR !== "undefined") ||
      (process.env.GROK_VERSION && process.env.GROK_VERSION !== "undefined")
    ) {
      return true;
    }
    if (process.env._ && path.basename(process.env._).toLowerCase().includes("grok")) {
      return true;
    }
    if (process.title && path.basename(process.title).toLowerCase().includes("grok")) {
      return true;
    }
    return false;
  }

  /**
   * Identifies whether Grok Build is the host harness for this workspace (§44).
   */
  async identifyHost(workspaceRoot?: string): Promise<boolean> {
    if (this.hasActiveRuntimeContext(workspaceRoot)) {
      return true;
    }

    if (workspaceRoot) {
      const candidates = [
        path.join(workspaceRoot, ".grok"),
        path.join(workspaceRoot, ".grok", "config.toml"),
        path.join(workspaceRoot, "grok.toml"),
      ];
      if (candidates.some((p) => fs.existsSync(p))) {
        return true;
      }
    }

    if (process.env.GROK_HOME && fs.existsSync(process.env.GROK_HOME)) {
      return true;
    }

    if (!workspaceRoot) {
      const userCandidates = [
        path.join(os.homedir(), ".grok"),
        path.join(os.homedir(), ".config", "grok"),
        path.join(os.homedir(), ".grok.toml"),
      ];
      return userCandidates.some((p) => fs.existsSync(p));
    }

    return false;
  }

  /**
   * Inspects host version with fail-closed compatibility classification (§21, §22, §44).
   */
  async inspectVersion(workspaceRoot?: string): Promise<HostVersionInfo> {
    // 1. Try machine-readable runtime inspection (§45)
    const runtimeInspect = await this.runGrokInspect(workspaceRoot);
    if (runtimeInspect?.version) {
      return this.classifyVersion(runtimeInspect.version);
    }

    // 2. Try CLI grok --version
    const cliResult = await this.runCliCommand("grok", ["--version"], workspaceRoot);
    if (cliResult && cliResult.exitCode === 0 && cliResult.stdout.trim()) {
      const verMatch = cliResult.stdout.trim().match(/(\d+\.\d+(\.\d+)?(-[a-zA-Z0-9.]+)?)/);
      if (verMatch) {
        return this.classifyVersion(verMatch[1], cliResult.stdout.trim());
      }
    }

    // 3. Check environment variable
    if (process.env.GROK_VERSION) {
      return this.classifyVersion(process.env.GROK_VERSION);
    }

    // 4. Check workspace version file
    if (workspaceRoot) {
      const versionFile = path.join(workspaceRoot, ".grok", "version");
      if (fs.existsSync(versionFile)) {
        try {
          const raw = fs.readFileSync(versionFile, "utf-8").trim();
          if (raw) return this.classifyVersion(raw);
        } catch {
          // ignore
        }
      }
    }

    // 5. Check user version file
    const grokHome = process.env.GROK_HOME || path.join(os.homedir(), ".grok");
    const userVersionFile = path.join(grokHome, "version");
    if (fs.existsSync(userVersionFile)) {
      try {
        const raw = fs.readFileSync(userVersionFile, "utf-8").trim();
        if (raw) return this.classifyVersion(raw);
      } catch {
        // ignore
      }
    }

    return {
      version: undefined,
      compatibility: "unknown-version",
      fail_closed_for_mutation: true,
      raw: undefined,
    };
  }

  private classifyVersion(versionStr: string, raw?: string): HostVersionInfo {
    const normalized = versionStr.trim();
    if (normalized === "incompatible") {
      return {
        version: normalized,
        compatibility: "incompatible",
        fail_closed_for_mutation: true,
        raw: raw || normalized,
      };
    }
    if (normalized.startsWith("0.") || normalized.startsWith("1.")) {
      return {
        version: normalized,
        compatibility: "supported",
        fail_closed_for_mutation: false,
        raw: raw || normalized,
      };
    }
    if (normalized.startsWith("2.")) {
      return {
        version: normalized,
        compatibility: "partially-supported",
        fail_closed_for_mutation: false,
        raw: raw || normalized,
      };
    }
    return {
      version: normalized,
      compatibility: "unknown-version",
      fail_closed_for_mutation: true,
      raw: raw || normalized,
    };
  }

  /**
   * Inspects host capabilities with individual, authentic detection (§48).
   * Prioritizes runtime machine-readable inspection (`grok inspect --json`) over manual TOML parsing (§45).
   */
  async inspectCapabilities(workspaceRoot?: string): Promise<HostCapabilities> {
    const runtimeInspect = await this.runGrokInspect(workspaceRoot);
    const layered = this.readLayeredConfig(workspaceRoot);
    const models = await this.inspectModels(workspaceRoot);
    const effortValues = await this.inspectEffortValues(workspaceRoot);

    // 1. Subagents detection (§48)
    let subagentsState: CapabilityState = "unknown";
    let subagentsEvidence: HostModelEvidence | undefined = undefined;

    if (runtimeInspect?.subagents?.enabled !== undefined) {
      subagentsState = runtimeInspect.subagents.enabled ? "available" : "unavailable";
      subagentsEvidence = {
        kind: "host-runtime" as const,
        locator: "grok inspect --json",
      };
    } else if (
      layered.effectiveConfig.subagents === true ||
      layered.effectiveConfig.subagents?.enabled === true
    ) {
      subagentsState = "available";
      subagentsEvidence = {
        kind: "host-config" as const,
        locator: layered.projectFile || layered.userFile || ".grok/config.toml",
      };
    } else if (
      workspaceRoot &&
      fs.existsSync(path.join(workspaceRoot, ".grok", "agents"))
    ) {
      subagentsState = "available";
      subagentsEvidence = {
        kind: "host-config" as const,
        locator: path.join(workspaceRoot, ".grok", "agents"),
      };
    } else if (
      process.env.GROK_SUBAGENTS === "1" ||
      process.env.GROK_SUBAGENTS === "true"
    ) {
      subagentsState = "available";
      subagentsEvidence = {
        kind: "host-runtime" as const,
        locator: "process.env.GROK_SUBAGENTS",
      };
    } else if (
      layered.effectiveConfig.subagents === false ||
      layered.effectiveConfig.subagents?.enabled === false
    ) {
      subagentsState = "unavailable";
    }

    // 2. Parallelism & Concurrency detection (§48)
    // Conformance test requires: If concurrency max is not confirmed, parallelism must not be marked available!
    let parallelismState: CapabilityState = "unknown";
    let concurrencyState: CapabilityState = "unknown";
    let maxConcurrency: number | undefined = undefined;
    let concurrencyEvidence: HostModelEvidence | undefined = undefined;

    if (runtimeInspect?.parallelism !== undefined) {
      maxConcurrency = runtimeInspect.parallelism.max_concurrency;
      if (maxConcurrency && maxConcurrency > 1) {
        parallelismState = "available";
        concurrencyState = "available";
      } else if (runtimeInspect.parallelism.enabled === false) {
        parallelismState = "unavailable";
        concurrencyState = "unavailable";
      }
      concurrencyEvidence = {
        kind: "host-runtime" as const,
        locator: "grok inspect --json",
      };
    } else {
      const cfgMax =
        layered.effectiveConfig.max_concurrency ||
        layered.effectiveConfig.parallelism?.max_concurrency;
      const envMax = process.env.GROK_MAX_CONCURRENCY
        ? parseInt(process.env.GROK_MAX_CONCURRENCY, 10)
        : undefined;
      const detectedMax = cfgMax || envMax;

      if (detectedMax && detectedMax > 1) {
        maxConcurrency = detectedMax;
        parallelismState = "available";
        concurrencyState = "available";
        concurrencyEvidence = {
          kind: envMax ? "host-runtime" : "host-config",
          locator: envMax
            ? "process.env.GROK_MAX_CONCURRENCY"
            : layered.projectFile || layered.userFile || ".grok/config.toml",
        };
      } else if (
        layered.effectiveConfig.parallelism === false ||
        layered.effectiveConfig.parallelism?.enabled === false
      ) {
        parallelismState = "unavailable";
        concurrencyState = "unavailable";
      }
    }

    // 3. Threads detection
    const threadsState: CapabilityState =
      subagentsState === "available" ? "available" : "unknown";

    // 4. Model selection & Per-agent model selection
    const modelSelectionState: CapabilityState =
      models.length > 0 ? "available" : "unknown";

    let perAgentModelSelectionState: CapabilityState = "unknown";
    if (runtimeInspect?.subagents?.agent_specific_model !== undefined) {
      perAgentModelSelectionState = runtimeInspect.subagents.agent_specific_model
        ? "available"
        : "unavailable";
    } else if (
      layered.effectiveConfig.worker_model ||
      layered.effectiveConfig.agents ||
      (workspaceRoot && fs.existsSync(path.join(workspaceRoot, ".grok", "agents")))
    ) {
      perAgentModelSelectionState = "available";
    }

    // 5. Reasoning capability
    const reasoningState: CapabilityState =
      effortValues.length > 0 ? "available" : "unknown";

    return {
      host_id: "grok-build",
      adapter_id: "grok-build",
      workspace: workspaceRoot,
      observed_at: new Date().toISOString(),
      platform: process.platform,
      available_models: models,
      supported_effort_values: effortValues,
      default_effort_value: effortValues.includes("high")
        ? "high"
        : effortValues[0],
      capabilities: {
        subagents: {
          state: subagentsState,
          evidence: subagentsEvidence,
        },
        threads: {
          state: threadsState,
          evidence: subagentsEvidence,
        },
        parallelism: {
          state: parallelismState,
          evidence: concurrencyEvidence,
        },
        model_selection: {
          state: modelSelectionState,
          scopes:
            modelSelectionState === "available"
              ? ["current-session", "new-session", "per-agent"]
              : undefined,
        },
        per_agent_model_selection: {
          state: perAgentModelSelectionState,
        },
        concurrency: {
          state: concurrencyState,
          max_concurrency: maxConcurrency,
          evidence: concurrencyEvidence,
        },
        configuration_mutation: {
          state: "available",
          supports_native_files: true,
          supports_session_mutation: false,
        },
        reasoning: {
          state: reasoningState,
        },
      },
    };
  }

  /**
   * Inspects evidenced models without guessing or fabrications (§45, §48).
   * Prioritizes machine-readable runtime inspection (`grok inspect --json`).
   */
  async inspectModels(workspaceRoot?: string): Promise<HostModel[]> {
    const models: HostModel[] = [];
    const seen = new Set<string>();

    // 1. Runtime inspect priority (§45)
    const runtimeInspect = await this.runGrokInspect(workspaceRoot);
    if (runtimeInspect) {
      const candidates: string[] = [];
      if (runtimeInspect.models) {
        for (const m of runtimeInspect.models) {
          if (typeof m === "string") candidates.push(m);
          else if (m && typeof m.id === "string") candidates.push(m.id);
        }
      }
      if (runtimeInspect.supported_models) {
        candidates.push(...runtimeInspect.supported_models);
      }
      if (runtimeInspect.model) {
        candidates.push(runtimeInspect.model);
      }
      if (runtimeInspect.worker_model) {
        candidates.push(runtimeInspect.worker_model);
      }

      for (const id of candidates) {
        if (!seen.has(id)) {
          seen.add(id);
          models.push({
            id,
            label: id,
            state: "available",
            features: ["tools"],
            evidence: {
              kind: "host-runtime",
              locator: "grok inspect --json",
            },
          });
        }
      }

      if (models.length > 0) {
        return models;
      }
    }

    // 2. Layered configuration fallback (§46)
    const layered = this.readLayeredConfig(workspaceRoot);
    const extractFromConfig = (cfg: ParsedToml | undefined, locator: string) => {
      if (!cfg) return;
      const ids: string[] = [];
      if (typeof cfg.model === "string") ids.push(cfg.model);
      if (typeof cfg.worker_model === "string") ids.push(cfg.worker_model);
      if (Array.isArray(cfg.models)) {
        for (const item of cfg.models) {
          if (typeof item === "string") ids.push(item);
        }
      }
      if (Array.isArray(cfg.supported_models)) {
        for (const item of cfg.supported_models) {
          if (typeof item === "string") ids.push(item);
        }
      }
      for (const id of ids) {
        if (!seen.has(id)) {
          seen.add(id);
          models.push({
            id,
            label: id,
            state: "available",
            features: ["tools"],
            evidence: {
              kind: "host-config",
              locator,
            },
          });
        }
      }
    };

    // Extract according to layering: policy, managed, project, user
    if (layered.policyConfig && layered.policyFiles[0]) {
      extractFromConfig(layered.policyConfig, layered.policyFiles[0]);
    }
    if (layered.managedConfig && layered.managedFiles[0]) {
      extractFromConfig(layered.managedConfig, layered.managedFiles[0]);
    }
    if (layered.projectConfig && layered.projectFile) {
      extractFromConfig(layered.projectConfig, layered.projectFile);
    }
    if (!workspaceRoot && layered.userConfig && layered.userFile) {
      extractFromConfig(layered.userConfig, layered.userFile);
    }

    // 3. Check workspace agents directory
    if (workspaceRoot) {
      const agentsDir = path.join(workspaceRoot, ".grok", "agents");
      if (fs.existsSync(agentsDir)) {
        try {
          const files = fs.readdirSync(agentsDir);
          for (const file of files) {
            if (file.endsWith(".toml")) {
              const filePath = path.join(agentsDir, file);
              const content = fs.readFileSync(filePath, "utf-8");
              const parsed = parseToml(content);
              if (parsed.model && typeof parsed.model === "string" && !seen.has(parsed.model)) {
                seen.add(parsed.model);
                models.push({
                  id: parsed.model,
                  label: parsed.model,
                  state: "available",
                  features: ["tools"],
                  evidence: {
                    kind: "host-config",
                    locator: filePath,
                  },
                });
              }
            }
          }
        } catch {
          // ignore
        }
      }
    }

    return models;
  }

  /**
   * Inspects supported effort values. Returns empty array when unevidenced (§48).
   */
  async inspectEffortValues(workspaceRoot?: string): Promise<string[]> {
    // 1. Runtime inspect priority (§45)
    const runtimeInspect = await this.runGrokInspect(workspaceRoot);
    if (runtimeInspect?.supported_effort_values && runtimeInspect.supported_effort_values.length > 0) {
      return runtimeInspect.supported_effort_values;
    }
    if (runtimeInspect?.reasoning_effort) {
      return [runtimeInspect.reasoning_effort];
    }

    // 2. Layered configuration fallback (§46)
    const layered = this.readLayeredConfig(workspaceRoot);
    const customLevels = layered.effectiveConfig.supported_effort_values;
    if (Array.isArray(customLevels) && customLevels.length > 0) {
      return customLevels.map((c) => String(c));
    }
    if (layered.effectiveConfig.reasoning_effort) {
      return [String(layered.effectiveConfig.reasoning_effort)];
    }

    return [];
  }

  /**
   * Inspects reasoning options (§11, §44).
   */
  async inspectReasoningOptions(workspaceRoot?: string): Promise<HostReasoningOptions> {
    const effortValues = await this.inspectEffortValues(workspaceRoot);
    return {
      native_field: "reasoning_effort",
      supported_values: effortValues,
      default_value: effortValues.includes("high") ? "high" : effortValues[0],
    };
  }

  /**
   * Inspects topology capabilities with individual verification (§48).
   */
  async inspectExecutionTopologyCapabilities(workspaceRoot?: string): Promise<TopologyCapabilities> {
    const caps = await this.inspectCapabilities(workspaceRoot);
    const subagentsAvailable = caps.capabilities.subagents.state === "available";
    const parallelismAvailable = caps.capabilities.parallelism.state === "available";

    return {
      supports_single_session: true,
      supports_subagents: subagentsAvailable,
      supports_multi_agent: subagentsAvailable,
      supports_parallel_execution: parallelismAvailable,
      max_concurrency: caps.capabilities.concurrency?.max_concurrency,
      scopes: subagentsAvailable
        ? ["current-session", "new-session", "per-agent"]
        : ["current-session", "new-session"],
    };
  }

  /**
   * Inspects Companion MCP registration status (§47).
   */
  async inspectCompanionRegistration(
    workspaceRoot?: string,
    scope?: "project" | "user"
  ): Promise<CompanionRegistrationStatus> {
    // 1. Check runtime inspection if available (§45)
    const runtimeInspect = await this.runGrokInspect(workspaceRoot);
    const mcpServers = runtimeInspect?.mcp?.servers || runtimeInspect?.mcp_servers;
    if (mcpServers?.["agent-config"]) {
      const server = mcpServers["agent-config"];
      return {
        registered: true,
        transport: "stdio",
        command: server.command,
        args: server.args,
        details: server,
      };
    }

    // 2. Check layered configs (§46, §47)
    const layered = this.readLayeredConfig(workspaceRoot);

    const checkTomlForCompanion = (cfg: ParsedToml | undefined, targetFile?: string, sc?: "project" | "global") => {
      if (!cfg) return null;
      const servers = cfg.mcp?.servers || cfg.mcp_servers;
      if (servers && servers["agent-config"]) {
        const s = servers["agent-config"];
        return {
          registered: true,
          transport: "stdio" as const,
          scope: sc,
          locator: targetFile,
          command: s.command,
          args: s.args,
          target_file: targetFile,
          details: s,
        };
      }
      return null;
    };

    // Project scope
    if (scope !== "user" && workspaceRoot) {
      const projResult = checkTomlForCompanion(layered.projectConfig, layered.projectFile, "project");
      if (projResult) return projResult;
    }

    // User scope
    if (scope !== "project") {
      const userResult = checkTomlForCompanion(layered.userConfig, layered.userFile, "global");
      if (userResult) return userResult;
    }

    const defaultTarget =
      scope === "user" || !workspaceRoot
        ? path.join(process.env.GROK_HOME || path.join(os.homedir(), ".grok"), "config.toml")
        : path.join(workspaceRoot, ".grok", "config.toml");
    const resolvedScope: "project" | "global" = scope === "user" || !workspaceRoot ? "global" : "project";

    return {
      registered: false,
      scope: resolvedScope,
      locator: defaultTarget,
      target_file: defaultTarget,
    };
  }

  /**
   * Previews companion registration patch against writable target config (§47).
   */
  async previewCompanionRegistration(
    workspaceRoot?: string,
    scope?: "project" | "user"
  ): Promise<CompanionRegistrationPreview> {
    const workspace = workspaceRoot || process.cwd();
    const targetFile =
      scope === "user" || !workspaceRoot
        ? path.join(process.env.GROK_HOME || path.join(os.homedir(), ".grok"), "config.toml")
        : path.join(workspace, ".grok", "config.toml");
    const resolvedScope: "project" | "global" = scope === "user" || !workspaceRoot ? "global" : "project";

    let existingContent: string | null = null;
    if (fs.existsSync(targetFile)) {
      existingContent = await fsp.readFile(targetFile, "utf-8");
      try {
        parseToml(existingContent);
      } catch (err: any) {
        return {
          supported: false,
          adapter_id: this.id,
          host_id: this.id,
          scope: resolvedScope,
          target_file: targetFile,
          mutation_targets: [],
          error: `Existing Grok Build configuration at '${targetFile}' is invalid TOML: ${err.message}`,
        };
      }
    }

    const baselineHash = existingContent
      ? crypto.createHash("sha256").update(existingContent).digest("hex")
      : null;

    const newContent = this.updateTomlMcpServer(
      existingContent || "",
      "agent-config",
      "agent-config",
      ["serve"]
    );

    const diff = createUnifiedDiff(targetFile, existingContent, newContent);
    const previewId = `preview-companion-grok-${Date.now()}`;
    const previewHash = crypto.createHash("sha256").update(newContent).digest("hex");

    return {
      supported: true,
      adapter_id: this.id,
      host_id: this.id,
      scope: resolvedScope,
      preview_id: previewId,
      preview_hash: previewHash,
      target_file: targetFile,
      baseline_hash: baselineHash,
      diff,
      mutation_targets: [targetFile],
      files: [{ path: targetFile, content: newContent }],
    };
  }

  /**
   * Applies companion registration with explicit approval and host command prioritization (§47).
   */
  async applyCompanionRegistration(
    previewHash: string,
    workspaceRoot?: string
  ): Promise<ApplyResult> {
    const preview = await this.previewCompanionRegistration(workspaceRoot);
    if (!preview.supported || !preview.files || preview.files.length === 0) {
      return {
        success: false,
        preview_id: previewHash,
        applied_targets: [],
        error: preview.error || "Companion registration preview generation failed.",
      };
    }

    if (preview.preview_hash !== previewHash) {
      return {
        success: false,
        preview_id: previewHash,
        applied_targets: [],
        error: `Preview hash mismatch. Expected ${preview.preview_hash}, got ${previewHash}.`,
      };
    }

    // Evaluate native `grok mcp add` command priority (§47)
    const nativeCliResult = await this.runCliCommand(
      "grok",
      ["mcp", "add", "agent-config", "agent-config", "serve"],
      workspaceRoot
    );
    if (nativeCliResult && nativeCliResult.exitCode === 0) {
      return {
        success: true,
        preview_id: preview.preview_id || previewHash,
        applied_targets: preview.mutation_targets,
        message: "Successfully registered companion MCP server via 'grok mcp add'.",
      };
    }

    // Fall back to applying target configuration file patch
    for (const file of preview.files) {
      const parentDir = path.dirname(file.path);
      if (!fs.existsSync(parentDir)) {
        await fsp.mkdir(parentDir, { recursive: true });
      }
      await fsp.writeFile(file.path, file.content, "utf-8");
    }

    return {
      success: true,
      preview_id: preview.preview_id || previewHash,
      applied_targets: preview.mutation_targets,
      message: "Successfully applied companion MCP registration patch to Grok Build config.",
    };
  }

  /**
   * Validates companion registration via read-back (§47).
   */
  async validateCompanionRegistration(workspaceRoot?: string): Promise<ValidationResult> {
    const status = await this.inspectCompanionRegistration(workspaceRoot);
    return {
      valid: status.registered,
      workspace: workspaceRoot,
      message: status.registered
        ? "Grok Build companion MCP server is registered."
        : "Grok Build companion MCP server is not registered.",
      details: status,
    };
  }

  /**
   * Previews configuration without flattening and strictly protecting policy/managed layers (§46, §48).
   */
  async previewConfiguration(
    plan: ExecutionConfig,
    profile?: AgentProfile,
    workspaceRoot?: string
  ): Promise<RenderedConfiguration> {
    return this.renderConfiguration(plan, profile, workspaceRoot);
  }

  /**
   * Renders configuration for Grok Build respecting layer boundaries (§46).
   */
  async renderConfiguration(
    plan: ExecutionConfig,
    profile?: AgentProfile,
    workspaceRoot?: string
  ): Promise<RenderedConfiguration> {
    const workspace = workspaceRoot || process.cwd();
    const grokDir = path.join(workspace, ".grok");
    const configTomlPath = this.resolveConfigPath(workspaceRoot, workspaceRoot ? "project" : undefined) ||
      path.join(grokDir, "config.toml");

    const layered = this.readLayeredConfig(workspaceRoot);

    // Enforce policy/managed layer protection (§46)
    if (layered.policyConfig?.deny_mutation === true) {
      throw new Error("Policy violation: configuration mutation is disabled by policy layer.");
    }

    const targetModel =
      plan.execution?.model ||
      plan.controller?.model ||
      profile?.single_model?.model;

    if (!targetModel) {
      throw new Error("Execution plan or profile does not specify a model for execution.");
    }

    if (layered.policyConfig?.model && targetModel !== layered.policyConfig.model) {
      throw new Error(
        `Policy violation: cannot override model '${targetModel}', model is locked to '${layered.policyConfig.model}' by policy layer.`
      );
    }
    if (layered.managedConfig?.model && targetModel !== layered.managedConfig.model) {
      throw new Error(
        `Policy violation: cannot override model '${targetModel}', model is locked to '${layered.managedConfig.model}' by managed layer.`
      );
    }

    const targetEffort =
      plan.execution?.effort ||
      plan.execution?.effort_policy ||
      plan.controller?.effort ||
      plan.controller?.effort_policy ||
      (profile?.single_model?.execution_effort
        ? "value" in profile.single_model.execution_effort
          ? profile.single_model.execution_effort.value
          : profile.single_model.execution_effort.policy
        : undefined);

    let existingContent: string | null = null;
    if (fs.existsSync(configTomlPath)) {
      existingContent = await fsp.readFile(configTomlPath, "utf-8");
    }

    let newConfigContent = existingContent || "";
    newConfigContent = this.updateTomlKeyValue(newConfigContent, "model", targetModel);
    if (targetEffort) {
      newConfigContent = this.updateTomlKeyValue(newConfigContent, "reasoning_effort", targetEffort);
    }

    const files: RenderedFile[] = [
      {
        path: configTomlPath,
        content: newConfigContent,
      },
    ];

    let combinedDiff = createUnifiedDiff(configTomlPath, existingContent, newConfigContent);

    // If decomposed task has work_items, render per-agent configuration files under .grok/agents/ (§48)
    if (plan.work_items && plan.work_items.length > 0) {
      const agentsDir = path.join(grokDir, "agents");
      for (const item of plan.work_items) {
        const agentFilePath = path.join(agentsDir, `${item.ticket_id}.toml`);
        let existingAgentContent: string | null = null;
        if (fs.existsSync(agentFilePath)) {
          existingAgentContent = await fsp.readFile(agentFilePath, "utf-8");
        }

        const itemEffort = item.effort || item.effort_policy;
        let newAgentContent =
          `name = "${item.ticket_id}"\n` +
          `model = "${item.model}"\n`;
        if (itemEffort) {
          newAgentContent += `reasoning_effort = "${itemEffort}"\n`;
        }

        files.push({
          path: agentFilePath,
          content: newAgentContent,
        });

        combinedDiff += "\n" + createUnifiedDiff(agentFilePath, existingAgentContent, newAgentContent);
      }
    }

    const previewId = `preview-grok-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    return {
      preview_id: previewId,
      mutation_targets: files.map((f) => f.path),
      diff: combinedDiff,
      files,
    };
  }

  /**
   * Applies rendered configuration with preview verification and protection checks (§46).
   */
  async applyConfiguration(
    previewId: string,
    rendered?: RenderedConfiguration,
    workspaceRoot?: string
  ): Promise<ApplyResult> {
    if (!rendered || rendered.preview_id !== previewId) {
      return {
        success: false,
        preview_id: previewId,
        applied_targets: [],
        error: `Invalid or missing preview configuration for preview ID '${previewId}'.`,
      };
    }

    const versionInfo = await this.inspectVersion(workspaceRoot);
    if (versionInfo.fail_closed_for_mutation) {
      return {
        success: false,
        preview_id: previewId,
        applied_targets: [],
        error: `Grok Build version compatibility '${versionInfo.compatibility}' fails closed for configuration mutation.`,
      };
    }

    const layered = this.readLayeredConfig(workspaceRoot);
    const protectedFiles = new Set([...layered.policyFiles, ...layered.managedFiles]);

    const appliedTargets: string[] = [];
    if (rendered.files) {
      for (const file of rendered.files) {
        if (protectedFiles.has(file.path) || file.path.includes("/etc/grok") || file.path.endsWith("managed.toml") || file.path.endsWith("policy.toml")) {
          return {
            success: false,
            preview_id: previewId,
            applied_targets: appliedTargets,
            error: `Policy violation: protected managed/policy file '${file.path}' cannot be mutated.`,
          };
        }

        const parentDir = path.dirname(file.path);
        if (!fs.existsSync(parentDir)) {
          await fsp.mkdir(parentDir, { recursive: true });
        }
        await fsp.writeFile(file.path, file.content, "utf-8");
        appliedTargets.push(file.path);
      }
    }

    return {
      success: true,
      preview_id: previewId,
      applied_targets: appliedTargets,
      message: `Successfully applied Grok Build configuration across ${appliedTargets.length} target(s).`,
    };
  }

  /**
   * Validates effective configuration against expected plan (§74).
   */
  async validateConfiguration(
    expected: ExecutionConfig,
    workspaceRoot?: string
  ): Promise<ValidationResult> {
    const workspace = workspaceRoot || process.cwd();
    const errors: string[] = [];

    const expectedModel = expected.execution?.model || expected.controller?.model;
    const expectedEffort =
      expected.execution?.effort ||
      expected.execution?.effort_policy ||
      expected.controller?.effort ||
      expected.controller?.effort_policy;

    const runtimeInspect = await this.runGrokInspect(workspaceRoot);
    const layered = this.readLayeredConfig(workspaceRoot);

    const actualModel = runtimeInspect?.model || layered.effectiveConfig.model;
    const actualEffort = runtimeInspect?.reasoning_effort || layered.effectiveConfig.reasoning_effort;

    if (expectedModel && actualModel !== expectedModel) {
      errors.push(`Controller model mismatch: expected '${expectedModel}', actual '${actualModel}'`);
    }

    if (expectedEffort && actualEffort !== expectedEffort) {
      errors.push(`Reasoning effort mismatch: expected '${expectedEffort}', actual '${actualEffort}'`);
    }

    // If decomposed, validate worker configurations
    if (expected.work_items && expected.work_items.length > 0) {
      const agentsDir = path.join(workspace, ".grok", "agents");
      for (const item of expected.work_items) {
        const agentFile = path.join(agentsDir, `${item.ticket_id}.toml`);
        if (!fs.existsSync(agentFile)) {
          errors.push(`Missing worker agent configuration file for ticket '${item.ticket_id}' at '${agentFile}'`);
          continue;
        }

        try {
          const content = fs.readFileSync(agentFile, "utf-8");
          const parsed = parseToml(content);
          if (parsed.model !== item.model) {
            errors.push(`Worker agent '${item.ticket_id}' model mismatch: expected '${item.model}', actual '${parsed.model}'`);
          }
          const itemEffort = item.effort || item.effort_policy;
          if (itemEffort && parsed.reasoning_effort !== itemEffort) {
            errors.push(
              `Worker agent '${item.ticket_id}' reasoning effort mismatch: expected '${itemEffort}', actual '${parsed.reasoning_effort}'`
            );
          }
        } catch (err: any) {
          errors.push(`Failed to parse worker agent configuration '${agentFile}': ${err.message}`);
        }
      }
    }

    const valid = errors.length === 0;
    return {
      valid,
      workspace,
      message: valid
        ? "Grok Build host configuration matches expected execution plan."
        : `Grok Build configuration drift detected: ${errors.join("; ")}`,
      errors: valid ? undefined : errors,
    };
  }

  /**
   * Resolves abstract reasoning policy to Grok Build native representation (§11, §12).
   */
  async resolveReasoningPolicy(
    policy: string,
    _modelId?: string,
    workspaceRoot?: string
  ): Promise<ResolvedReasoningPolicy | undefined> {
    const supported = await this.inspectEffortValues(workspaceRoot);
    if (!supported || supported.length === 0) {
      return undefined;
    }

    const normalized = policy.toLowerCase().trim();
    let resolvedValue: string | undefined;

    if (normalized === "highest-supported") {
      if (supported.includes("xhigh")) resolvedValue = "xhigh";
      else if (supported.includes("high")) resolvedValue = "high";
      else if (supported.includes("max")) resolvedValue = "max";
      else resolvedValue = supported[supported.length - 1];
    } else if (normalized === "lowest-sufficient" || normalized === "lowest-supported") {
      if (supported.includes("low")) resolvedValue = "low";
      else if (supported.includes("min")) resolvedValue = "min";
      else resolvedValue = supported[0];
    } else if (normalized === "configured") {
      resolvedValue = supported.includes("high") ? "high" : supported[0];
    } else if (supported.includes(policy)) {
      resolvedValue = policy;
    } else {
      const match = supported.find((v) => v.toLowerCase() === normalized);
      if (match) resolvedValue = match;
    }

    if (!resolvedValue) {
      return undefined;
    }

    return {
      host_field: "reasoning_effort",
      host_value: resolvedValue,
    };
  }

  /**
   * Evaluates config layering across user, project, managed, and policy layers (§46).
   * Precedence: Policy > Managed > Project > User.
   * Never flattens effective config to disk!
   */
  readLayeredConfig(workspaceRoot?: string): GrokLayeredConfig {
    let policyConfig: ParsedToml | undefined;
    let managedConfig: ParsedToml | undefined;
    let projectConfig: ParsedToml | undefined;
    let userConfig: ParsedToml | undefined;

    const policyFiles: string[] = [];
    const managedFiles: string[] = [];
    let projectFile: string | undefined;
    let userFile: string | undefined;

    // 1. Policy layer
    const policyCandidates = [
      process.env.GROK_POLICY_FILE,
      "/etc/grok/policy.toml",
      workspaceRoot ? path.join(workspaceRoot, ".grok", "policy.toml") : undefined,
      workspaceRoot ? path.join(workspaceRoot, "policy.toml") : undefined,
    ].filter((p): p is string => Boolean(p && fs.existsSync(p)));

    for (const p of policyCandidates) {
      try {
        const parsed = parseToml(fs.readFileSync(p, "utf-8"));
        policyConfig = this.deepMerge(policyConfig || {}, parsed);
        policyFiles.push(p);
      } catch {
        // ignore malformed policy file in read
      }
    }

    // 2. Managed layer
    const managedCandidates = [
      process.env.GROK_MANAGED_CONFIG,
      "/etc/grok/managed.toml",
      "/etc/grok/config.toml",
      workspaceRoot ? path.join(workspaceRoot, ".grok", "managed.toml") : undefined,
    ].filter((p): p is string => Boolean(p && fs.existsSync(p)));

    for (const p of managedCandidates) {
      try {
        const parsed = parseToml(fs.readFileSync(p, "utf-8"));
        managedConfig = this.deepMerge(managedConfig || {}, parsed);
        managedFiles.push(p);
      } catch {
        // ignore malformed managed file in read
      }
    }

    // 3. Project layer
    if (workspaceRoot) {
      const projCandidates = [
        path.join(workspaceRoot, ".grok", "config.toml"),
        path.join(workspaceRoot, "grok.toml"),
      ];
      for (const p of projCandidates) {
        if (fs.existsSync(p)) {
          projectFile = p;
          try {
            projectConfig = parseToml(fs.readFileSync(p, "utf-8"));
          } catch {
            // ignore malformed project config
          }
          break;
        }
      }
    }

    // 4. User layer
    const userCandidates = [
      process.env.GROK_HOME ? path.join(process.env.GROK_HOME, "config.toml") : undefined,
      path.join(os.homedir(), ".grok", "config.toml"),
      path.join(os.homedir(), ".config", "grok", "config.toml"),
    ].filter((p): p is string => Boolean(p && fs.existsSync(p)));

    if (userCandidates.length > 0) {
      userFile = userCandidates[0];
      try {
        userConfig = parseToml(fs.readFileSync(userFile, "utf-8"));
      } catch {
        // ignore malformed user config
      }
    }

    // Locked keys set by policy or managed layers
    const lockedKeys = new Set<string>();
    if (policyConfig) {
      for (const k of Object.keys(policyConfig)) lockedKeys.add(k);
    }
    if (managedConfig) {
      for (const k of Object.keys(managedConfig)) lockedKeys.add(k);
    }

    // In-memory effective merge (Policy > Managed > Project > User)
    const effectiveConfig: ParsedToml = {};
    if (userConfig) this.deepMerge(effectiveConfig, userConfig);
    if (projectConfig) this.deepMerge(effectiveConfig, projectConfig);
    if (managedConfig) this.deepMerge(effectiveConfig, managedConfig);
    if (policyConfig) this.deepMerge(effectiveConfig, policyConfig);

    return {
      policyConfig,
      managedConfig,
      projectConfig,
      userConfig,
      effectiveConfig,
      lockedKeys,
      policyFiles,
      managedFiles,
      projectFile,
      userFile,
    };
  }

  private deepMerge(target: Record<string, any>, source: Record<string, any>): Record<string, any> {
    for (const key of Object.keys(source)) {
      const sVal = source[key];
      if (
        sVal &&
        typeof sVal === "object" &&
        !Array.isArray(sVal) &&
        target[key] &&
        typeof target[key] === "object" &&
        !Array.isArray(target[key])
      ) {
        this.deepMerge(target[key], sVal);
      } else {
        target[key] = sVal;
      }
    }
    return target;
  }

  private resolveConfigPath(workspaceRoot?: string, scope?: "project" | "user"): string | null {
    if (scope === "user") {
      const grokHome = process.env.GROK_HOME || path.join(os.homedir(), ".grok");
      const p = path.join(grokHome, "config.toml");
      return fs.existsSync(p) ? p : null;
    }

    if (workspaceRoot) {
      const p = path.join(workspaceRoot, ".grok", "config.toml");
      if (fs.existsSync(p)) return p;
      const rootToml = path.join(workspaceRoot, "grok.toml");
      if (fs.existsSync(rootToml)) return rootToml;
      return null;
    }

    const grokHome = process.env.GROK_HOME || path.join(os.homedir(), ".grok");
    const p = path.join(grokHome, "config.toml");
    if (fs.existsSync(p)) return p;
    return null;
  }

  private updateTomlKeyValue(content: string, key: string, value: string): string {
    const lineRegex = new RegExp(`^(\\s*${key}\\s*=\\s*).*$`, "m");
    const quoted = `"${value.replace(/"/g, '\\"')}"`;
    if (lineRegex.test(content)) {
      return content.replace(lineRegex, `${key} = ${quoted}`);
    }
    const trimmed = content.trim();
    return trimmed ? `${key} = ${quoted}\n${trimmed}\n` : `${key} = ${quoted}\n`;
  }

  private updateTomlMcpServer(
    content: string,
    name: string,
    command: string,
    args: string[]
  ): string {
    const argsToml = `[${args.map((a) => `"${a.replace(/"/g, '\\"')}"`).join(", ")}]`;
    const serverHeaderRegex = new RegExp(
      `\\[mcp\\.(?:servers|servers\\.${name})\\]|\\[mcp_servers\\.${name}\\]`,
      "m"
    );

    if (content.includes(`[mcp.servers.${name}]`)) {
      return content;
    }

    const trimmed = content.trim();
    const serverBlock = `[mcp.servers.${name}]\ncommand = "${command}"\nargs = ${argsToml}\n`;

    if (serverHeaderRegex.test(content)) {
      return `${trimmed}\n\n${serverBlock}`;
    }

    return trimmed ? `${trimmed}\n\n${serverBlock}` : serverBlock;
  }

  /**
   * Executes machine-readable runtime inspection (`grok inspect --json`) when host supports it (§45).
   */
  private async runGrokInspect(workspaceRoot?: string): Promise<GrokInspectOutput | null> {
    const res = await this.runCliCommand("grok", ["inspect", "--json"], workspaceRoot);
    if (!res || res.exitCode !== 0 || !res.stdout.trim()) {
      return null;
    }
    try {
      return JSON.parse(res.stdout);
    } catch {
      return null;
    }
  }

  /**
   * Safely executes host CLI subprocess with timeout (§44, §45).
   */
  private async runCliCommand(
    command: string,
    args: string[],
    cwd?: string
  ): Promise<{ stdout: string; stderr: string; exitCode: number } | null> {
    return new Promise((resolve) => {
      try {
        childProcess.execFile(
          command,
          args,
          { cwd, timeout: 2000 },
          (error, stdout, stderr) => {
            if (error) {
              resolve(null);
            } else {
              resolve({
                stdout: stdout?.toString() || "",
                stderr: stderr?.toString() || "",
                exitCode: 0,
              });
            }
          }
        );
      } catch {
        resolve(null);
      }
    });
  }
}
