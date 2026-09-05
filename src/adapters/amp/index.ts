import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import childProcess from "node:child_process";
import * as jsonc from "jsonc-parser";
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
} from "../contract.js";
import { ExecutionConfig, AgentProfile } from "../../profile/schema.js";
import { createUnifiedDiff } from "../diff.js";

/**
 * Amp Native Adapter supporting Amp CLI and Agent capabilities,
 * workspace and global configuration inspection, standard MCP registration,
 * model inventory, and safe configuration lifecycle.
 */
export class AmpAdapter implements HostAdapter {
  readonly id = "amp";
  readonly name = "Amp Adapter";

  /**
   * Detects active Amp runtime environment from process environment or ancestry.
   */
  hasActiveRuntimeContext(_workspaceRoot?: string): boolean {
    if (
      process.env.AMP_CLI === "1" ||
      process.env.AMP_CLI === "true" ||
      process.env.AMP_AGENT === "1" ||
      process.env.AMP_AGENT === "true" ||
      (process.env.AMP_SESSION && process.env.AMP_SESSION !== "undefined") ||
      (process.env.AMP_SESSION_ID && process.env.AMP_SESSION_ID !== "undefined") ||
      (process.env.AMP_PROJECT_DIR && process.env.AMP_PROJECT_DIR !== "undefined") ||
      (process.env.AMP_CONFIG_DIR && process.env.AMP_CONFIG_DIR !== "undefined") ||
      (process.env.AMP_HOME && process.env.AMP_HOME !== "undefined") ||
      (process.env.AMP_VERSION && process.env.AMP_VERSION !== "undefined") ||
      (process.env.AMP_MODEL && process.env.AMP_MODEL !== "undefined")
    ) {
      return true;
    }
    if (process.env._ && path.basename(process.env._).toLowerCase().includes("amp")) {
      return true;
    }
    if (process.title && path.basename(process.title).toLowerCase().includes("amp")) {
      return true;
    }
    return false;
  }

  /**
   * Identifies if Amp is the host harness for this workspace.
   */
  async identifyHost(workspaceRoot?: string): Promise<boolean> {
    if (this.hasActiveRuntimeContext(workspaceRoot)) {
      return true;
    }

    if (workspaceRoot) {
      const candidates = [
        path.join(workspaceRoot, ".amp"),
        path.join(workspaceRoot, ".amp", "settings.json"),
        path.join(workspaceRoot, ".amp", "config.json"),
        path.join(workspaceRoot, ".amp", "mcp.json"),
        path.join(workspaceRoot, "amp.json"),
        path.join(workspaceRoot, ".amp.json"),
      ];
      if (candidates.some((p) => fs.existsSync(p))) {
        return true;
      }
    }

    if (process.env.AMP_CONFIG_DIR && fs.existsSync(process.env.AMP_CONFIG_DIR)) {
      return true;
    }

    if (!workspaceRoot) {
      const userCandidates = [
        path.join(os.homedir(), ".amp"),
        path.join(os.homedir(), ".config", "amp"),
        path.join(os.homedir(), ".amp", "settings.json"),
        path.join(os.homedir(), ".amp", "config.json"),
        path.join(os.homedir(), ".amp", "mcp.json"),
        path.join(os.homedir(), "amp.json"),
      ];
      return userCandidates.some((p) => fs.existsSync(p));
    }

    return false;
  }

  /**
   * Inspects Amp host version and determines compatibility.
   */
  async inspectVersion(workspaceRoot?: string): Promise<HostVersionInfo> {
    let version = process.env.AMP_VERSION || process.env.AMP_CLI_VERSION;
    let raw: string | undefined = version;

    if (!version && workspaceRoot) {
      const versionFile = path.join(workspaceRoot, ".amp", "version");
      if (fs.existsSync(versionFile)) {
        try {
          raw = fs.readFileSync(versionFile, "utf-8").trim();
          version = raw;
        } catch {
          // Skip
        }
      } else {
        const configFile = path.join(workspaceRoot, ".amp", "config.json");
        const settingsFile = path.join(workspaceRoot, ".amp", "settings.json");
        for (const file of [configFile, settingsFile]) {
          if (fs.existsSync(file)) {
            try {
              const parsed = jsonc.parse(fs.readFileSync(file, "utf-8"));
              if (parsed && typeof parsed.version === "string") {
                version = parsed.version;
                raw = parsed.version;
                break;
              }
            } catch {
              // Skip
            }
          }
        }
      }
    }

    if (!version) {
      const cliResult = await this.runCliCommand("amp", ["--version"], workspaceRoot);
      if (cliResult && cliResult.stdout.trim().length > 0) {
        raw = cliResult.stdout.trim().split(/\r?\n/)[0];
        const match = raw.match(/\d+\.\d+(\.\d+)?/);
        if (match) {
          version = match[0];
        }
      }
    }

    if (!version) {
      const userVersionFile = path.join(os.homedir(), ".amp", "version");
      if (fs.existsSync(userVersionFile)) {
        try {
          raw = fs.readFileSync(userVersionFile, "utf-8").trim();
          version = raw;
        } catch {
          // Skip
        }
      }
    }

    if (!version) {
      return {
        version: undefined,
        compatibility: "unknown-version",
        fail_closed_for_mutation: true,
        raw: undefined,
      };
    }

    const normalized = version.trim();
    if (normalized === "incompatible") {
      return {
        version: normalized,
        compatibility: "incompatible",
        fail_closed_for_mutation: true,
        raw,
      };
    }

    if (normalized.startsWith("0.") || normalized.startsWith("1.")) {
      return {
        version: normalized,
        compatibility: "supported",
        fail_closed_for_mutation: false,
        raw,
      };
    }

    if (normalized.startsWith("2.")) {
      return {
        version: normalized,
        compatibility: "partially-supported",
        fail_closed_for_mutation: false,
        raw,
      };
    }

    const semverMatch = normalized.match(/^\d+\.\d+(\.\d+)?/);
    if (semverMatch) {
      return {
        version: normalized,
        compatibility: "supported",
        fail_closed_for_mutation: false,
        raw,
      };
    }

    return {
      version: normalized,
      compatibility: "unknown-version",
      fail_closed_for_mutation: true,
      raw,
    };
  }

  /**
   * Determines target configuration file for workspace mutation.
   */
  determineTargetConfigPath(workspaceRoot: string): string {
    const ampDir = path.join(workspaceRoot, ".amp");
    const settingsFile = path.join(ampDir, "settings.json");
    if (fs.existsSync(settingsFile)) return settingsFile;

    const configFile = path.join(ampDir, "config.json");
    if (fs.existsSync(configFile)) return configFile;

    const rootAmpJson = path.join(workspaceRoot, "amp.json");
    if (fs.existsSync(rootAmpJson)) return rootAmpJson;

    return settingsFile;
  }

  /**
   * Determines target MCP registration file path.
   */
  determineMcpRegistrationPath(workspaceRoot: string): string {
    const mcpFile = path.join(workspaceRoot, ".amp", "mcp.json");
    if (fs.existsSync(mcpFile)) return mcpFile;

    const settingsFile = path.join(workspaceRoot, ".amp", "settings.json");
    if (fs.existsSync(settingsFile)) {
      try {
        const parsed = jsonc.parse(fs.readFileSync(settingsFile, "utf-8"));
        if (parsed?.mcpServers) return settingsFile;
      } catch {
        // Skip
      }
    }

    return mcpFile;
  }

  private readEffectiveConfig(workspaceRoot?: string): Record<string, any> | null {
    if (workspaceRoot) {
      const candidates = [
        path.join(workspaceRoot, ".amp", "settings.json"),
        path.join(workspaceRoot, ".amp", "config.json"),
        path.join(workspaceRoot, "amp.json"),
        path.join(workspaceRoot, ".amp.json"),
      ];
      for (const p of candidates) {
        if (fs.existsSync(p)) {
          try {
            const content = fs.readFileSync(p, "utf-8");
            const parsed = jsonc.parse(content);
            if (parsed && typeof parsed === "object") return parsed;
          } catch {
            // Skip
          }
        }
      }
    }

    const userCandidates = [
      path.join(os.homedir(), ".amp", "settings.json"),
      path.join(os.homedir(), ".amp", "config.json"),
      path.join(os.homedir(), ".config", "amp", "settings.json"),
    ];
    for (const p of userCandidates) {
      if (fs.existsSync(p)) {
        try {
          const content = fs.readFileSync(p, "utf-8");
          const parsed = jsonc.parse(content);
          if (parsed && typeof parsed === "object") return parsed;
        } catch {
          // Skip
        }
      }
    }

    return null;
  }

  /**
   * Inspects all host capabilities under strict unknown semantics.
   */
  async inspectCapabilities(workspaceRoot?: string): Promise<HostCapabilities> {
    const models = await this.inspectModels(workspaceRoot);
    const effortValues = await this.inspectEffortValues(workspaceRoot);

    // Concurrency detection
    let concurrencyLimit: number | undefined;
    let concurrencyState: "available" | "unknown" = "unknown";

    if (process.env.AMP_MAX_CONCURRENCY) {
      const parsed = parseInt(process.env.AMP_MAX_CONCURRENCY, 10);
      if (!isNaN(parsed) && parsed > 0) {
        concurrencyLimit = parsed;
        concurrencyState = "available";
      }
    }

    const config = this.readEffectiveConfig(workspaceRoot);
    if (config) {
      if (typeof config.concurrency === "number" && config.concurrency > 0) {
        concurrencyLimit = config.concurrency;
        concurrencyState = "available";
      } else if (typeof config.max_concurrency === "number" && config.max_concurrency > 0) {
        concurrencyLimit = config.max_concurrency;
        concurrencyState = "available";
      }
    }

    // Subagent detection
    let subagentsState: "available" | "unknown" = "unknown";
    let subagentsEvidenceLocator: string | undefined;

    if (workspaceRoot) {
      const agentsDir = path.join(workspaceRoot, ".amp", "agents");
      if (fs.existsSync(agentsDir)) {
        subagentsState = "available";
        subagentsEvidenceLocator = ".amp/agents";
      }
    }

    if (subagentsState === "unknown" && config) {
      if (config.subagents === true || (config.agents && typeof config.agents === "object")) {
        subagentsState = "available";
        subagentsEvidenceLocator = "amp.config.agents";
      }
    }

    // Threads detection
    let threadsState: "available" | "unknown" = "unknown";
    let threadsEvidenceLocator: string | undefined;

    if (workspaceRoot) {
      const threadsDir = path.join(workspaceRoot, ".amp", "threads");
      if (fs.existsSync(threadsDir)) {
        threadsState = "available";
        threadsEvidenceLocator = ".amp/threads";
      }
    }

    if (threadsState === "unknown" && config) {
      if (config.threads === true) {
        threadsState = "available";
        threadsEvidenceLocator = "amp.config.threads";
      }
    }

    // Parallelism strictly requires confirmed concurrency > 1
    const parallelismAvailable =
      concurrencyState === "available" &&
      typeof concurrencyLimit === "number" &&
      concurrencyLimit > 1;

    // Reasoning state
    const reasoningAvailable = effortValues.length > 0;

    return {
      host_id: this.id,
      adapter_id: this.id,
      workspace: workspaceRoot,
      observed_at: new Date().toISOString(),
      platform: process.platform,
      available_models: models,
      supported_effort_values: effortValues,
      default_effort_value: effortValues.length > 0 ? effortValues[0] : undefined,
      capabilities: {
        subagents: {
          state: subagentsState,
          ...(subagentsEvidenceLocator
            ? {
                evidence: {
                  kind: "host-config",
                  locator: subagentsEvidenceLocator,
                },
              }
            : {}),
        },
        threads: {
          state: threadsState,
          ...(threadsEvidenceLocator
            ? {
                evidence: {
                  kind: "host-config",
                  locator: threadsEvidenceLocator,
                },
              }
            : {}),
        },
        parallelism: {
          state: parallelismAvailable ? "available" : "unknown",
          ...(concurrencyLimit
            ? {
                evidence: {
                  kind: "host-config",
                  locator: `concurrency=${concurrencyLimit}`,
                },
              }
            : {}),
        },
        model_selection: {
          state: models.length > 0 ? "available" : "unknown",
          scopes: ["current-session", "new-session", "per-agent"],
        },
        per_agent_model_selection: {
          state: subagentsState === "available" ? "available" : "unknown",
        },
        concurrency: {
          state: concurrencyState,
          max_concurrency: concurrencyLimit,
        },
        configuration_mutation: {
          state: "available",
          supports_native_files: true,
          supports_session_mutation: false,
        },
        reasoning: {
          state: reasoningAvailable ? "available" : "unknown",
          ...(reasoningAvailable
            ? {
                evidence: {
                  kind: "host-config",
                  locator: "reasoning_effort",
                },
              }
            : {}),
        },
      },
    };
  }

  /**
   * Inspects models evidenced in Amp host configurations or environment.
   */
  async inspectModels(workspaceRoot?: string): Promise<HostModel[]> {
    const models: HostModel[] = [];
    const seen = new Set<string>();

    const addModel = (id: string, label?: string, locator?: string) => {
      if (!id || seen.has(id)) return;
      seen.add(id);
      models.push({
        id,
        label: label || id,
        state: "available",
        evidence: {
          kind: "host-config",
          locator: locator || "amp-config",
        },
      });
    };

    // 1. Workspace configs
    if (workspaceRoot) {
      const workspaceConfigs = [
        path.join(workspaceRoot, ".amp", "settings.json"),
        path.join(workspaceRoot, ".amp", "config.json"),
        path.join(workspaceRoot, "amp.json"),
      ];
      for (const cp of workspaceConfigs) {
        if (fs.existsSync(cp)) {
          try {
            const parsed = jsonc.parse(fs.readFileSync(cp, "utf-8"));
            if (parsed) {
              if (typeof parsed.model === "string") addModel(parsed.model, parsed.model, cp);
              if (typeof parsed.default_model === "string")
                addModel(parsed.default_model, parsed.default_model, cp);
              if (Array.isArray(parsed.models)) {
                for (const m of parsed.models) {
                  if (typeof m === "string") addModel(m, m, cp);
                  else if (m && typeof m.id === "string") addModel(m.id, m.name || m.id, cp);
                }
              }
            }
          } catch {
            // Skip
          }
        }
      }

      // Agents in workspace
      const agentsDir = path.join(workspaceRoot, ".amp", "agents");
      if (fs.existsSync(agentsDir)) {
        try {
          const entries = fs.readdirSync(agentsDir);
          for (const entry of entries) {
            if (entry.endsWith(".json")) {
              const agentFile = path.join(agentsDir, entry);
              try {
                const parsed = jsonc.parse(fs.readFileSync(agentFile, "utf-8"));
                if (parsed && typeof parsed.model === "string") {
                  addModel(parsed.model, parsed.name || parsed.model, agentFile);
                }
              } catch {
                // Skip
              }
            }
          }
        } catch {
          // Skip
        }
      }
    }

    // 2. User configs fallback
    const userConfigs = [
      path.join(os.homedir(), ".amp", "settings.json"),
      path.join(os.homedir(), ".amp", "config.json"),
      path.join(os.homedir(), ".config", "amp", "settings.json"),
    ];
    for (const cp of userConfigs) {
      if (fs.existsSync(cp)) {
        try {
          const parsed = jsonc.parse(fs.readFileSync(cp, "utf-8"));
          if (parsed) {
            if (typeof parsed.model === "string") addModel(parsed.model, parsed.model, cp);
            if (typeof parsed.default_model === "string")
              addModel(parsed.default_model, parsed.default_model, cp);
            if (Array.isArray(parsed.models)) {
              for (const m of parsed.models) {
                if (typeof m === "string") addModel(m, m, cp);
                else if (m && typeof m.id === "string") addModel(m.id, m.name || m.id, cp);
              }
            }
          }
        } catch {
          // Skip
        }
      }
    }

    // 3. Environment override
    if (process.env.AMP_MODEL) {
      addModel(process.env.AMP_MODEL, process.env.AMP_MODEL, "process.env.AMP_MODEL");
    }

    return models;
  }

  /**
   * Inspects supported reasoning effort values. Returns empty array if unevidenced.
   */
  async inspectEffortValues(workspaceRoot?: string): Promise<string[]> {
    const config = this.readEffectiveConfig(workspaceRoot);
    if (config) {
      if (Array.isArray(config.supported_effort_values)) {
        return config.supported_effort_values.map(String);
      }
      if (typeof config.reasoning_effort === "string") {
        return [config.reasoning_effort];
      }
      if (config.amp && typeof config.amp.reasoningEffort === "string") {
        return [config.amp.reasoningEffort];
      }
    }

    if (process.env.AMP_REASONING_EFFORT) {
      return [process.env.AMP_REASONING_EFFORT];
    }

    return [];
  }

  /**
   * Inspects native reasoning options for Amp.
   */
  async inspectReasoningOptions(workspaceRoot?: string): Promise<HostReasoningOptions> {
    const effortValues = await this.inspectEffortValues(workspaceRoot);
    return {
      native_field: "reasoning_effort",
      supported_values: effortValues,
      default_value: effortValues.length > 0 ? effortValues[0] : undefined,
    };
  }

  /**
   * Resolves abstract reasoning policy to Amp native representation.
   */
  async resolveReasoningPolicy(
    policy: string,
    _modelId?: string,
    workspaceRoot?: string
  ): Promise<ResolvedReasoningPolicy | undefined> {
    const effortValues = await this.inspectEffortValues(workspaceRoot);
    if (effortValues.length === 0) return undefined;

    const normalized = policy.toLowerCase().trim();
    let selectedValue: string | undefined;

    if (normalized === "highest-supported") {
      if (effortValues.includes("xhigh")) selectedValue = "xhigh";
      else if (effortValues.includes("high")) selectedValue = "high";
      else selectedValue = effortValues[effortValues.length - 1];
    } else if (normalized === "lowest-sufficient" || normalized === "lowest-supported") {
      if (effortValues.includes("low")) selectedValue = "low";
      else selectedValue = effortValues[0];
    } else if (normalized === "configured") {
      selectedValue = effortValues[0];
    } else if (effortValues.includes(policy)) {
      selectedValue = policy;
    } else {
      const match = effortValues.find((v) => v.toLowerCase() === normalized);
      if (match) selectedValue = match;
    }

    if (!selectedValue) return undefined;

    return {
      host_field: "reasoning_effort",
      host_value: selectedValue,
    };
  }

  /**
   * Inspects execution topology capabilities for Amp.
   */
  async inspectExecutionTopologyCapabilities(workspaceRoot?: string): Promise<TopologyCapabilities> {
    const caps = await this.inspectCapabilities(workspaceRoot);
    const parallelismAvailable = caps.capabilities.parallelism.state === "available";

    return {
      supports_single_session: true,
      supports_subagents: caps.capabilities.subagents.state === "available",
      supports_multi_agent: true,
      supports_parallel_execution: parallelismAvailable,
      max_concurrency: caps.capabilities.concurrency?.max_concurrency,
      scopes: ["current-session", "new-session", "per-agent"],
    };
  }

  /**
   * Inspects MCP companion registration across workspace and user scopes.
   */
  async inspectCompanionRegistration(
    workspaceRoot?: string,
    scope?: "project" | "global" | "user"
  ): Promise<CompanionRegistrationStatus> {
    const workspace = workspaceRoot || process.cwd();

    // 1. Workspace scope
    const workspaceMcpCandidates = [
      path.join(workspace, ".amp", "mcp.json"),
      path.join(workspace, ".amp", "settings.json"),
      path.join(workspace, ".amp", "config.json"),
    ];

    for (const targetFile of workspaceMcpCandidates) {
      if (fs.existsSync(targetFile)) {
        try {
          const content = fs.readFileSync(targetFile, "utf-8");
          const parsed = jsonc.parse(content);
          const serverConfig = parsed?.mcpServers?.["agent-config"];
          if (serverConfig) {
            return {
              registered: true,
              transport: "stdio",
              scope: "project",
              locator: targetFile,
              command: serverConfig.command,
              args: serverConfig.args,
              target_file: targetFile,
              details: { scope: "workspace", config: serverConfig },
            };
          }
        } catch {
          // Skip
        }
      }
    }

    // 2. User scope
    const userMcpCandidates = [
      path.join(os.homedir(), ".amp", "mcp.json"),
      path.join(os.homedir(), ".amp", "settings.json"),
      path.join(os.homedir(), ".config", "amp", "mcp.json"),
    ];

    for (const targetFile of userMcpCandidates) {
      if (fs.existsSync(targetFile)) {
        try {
          const content = fs.readFileSync(targetFile, "utf-8");
          const parsed = jsonc.parse(content);
          const serverConfig = parsed?.mcpServers?.["agent-config"];
          if (serverConfig) {
            return {
              registered: true,
              transport: "stdio",
              scope: "global",
              locator: targetFile,
              command: serverConfig.command,
              args: serverConfig.args,
              target_file: targetFile,
              details: { scope: "user", config: serverConfig },
            };
          }
        } catch {
          // Skip
        }
      }
    }

    const defaultTarget = this.determineMcpRegistrationPath(workspace);
    const resolvedScope: "project" | "global" =
      scope === "global" || scope === "user" || (!scope && !workspaceRoot)
        ? "global"
        : "project";
    return {
      registered: false,
      scope: resolvedScope,
      locator: defaultTarget,
      target_file: defaultTarget,
    };
  }

  /**
   * Previews companion registration into Amp configuration.
   */
  async previewCompanionRegistration(
    workspaceRoot?: string,
    scope?: "project" | "global" | "user"
  ): Promise<CompanionRegistrationPreview> {
    const workspace = workspaceRoot || process.cwd();
    const targetFile = this.determineMcpRegistrationPath(workspace);
    const resolvedScope: "project" | "global" =
      scope === "global" || scope === "user" || (!scope && !workspaceRoot)
        ? "global"
        : "project";

    let existingContent: string | null = null;
    let initialText = "{\n  \"mcpServers\": {}\n}\n";

    if (fs.existsSync(targetFile)) {
      existingContent = await fsp.readFile(targetFile, "utf-8");
      const parseErrors: jsonc.ParseError[] = [];
      jsonc.parse(existingContent, parseErrors, { allowTrailingComma: true });
      if (parseErrors.length > 0) {
        return {
          supported: false,
          adapter_id: this.id,
          host_id: this.id,
          scope: resolvedScope,
          target_file: targetFile,
          mutation_targets: [],
          error: `Amp configuration file at '${targetFile}' contains syntax errors. Rejecting companion registration to prevent loss.`,
        };
      }
      initialText = existingContent;
    }

    const baselineHash = existingContent
      ? crypto.createHash("sha256").update(existingContent).digest("hex")
      : null;

    const formatting = { formattingOptions: { insertSpaces: true, tabSize: 2 } };
    const edits = jsonc.modify(
      initialText,
      ["mcpServers", "agent-config"],
      { command: "agent-config", args: ["serve"] },
      formatting
    );
    const newContent = jsonc.applyEdits(initialText, edits);

    const diff = createUnifiedDiff(targetFile, existingContent, newContent);
    const previewId = `preview-companion-amp-${Date.now()}`;
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
   * Applies companion registration after verifying preview hash.
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
        error: preview.error || "Cannot apply companion registration for Amp.",
      };
    }

    if (!preview.preview_hash || previewHash !== preview.preview_hash) {
      return {
        success: false,
        preview_id: previewHash,
        applied_targets: [],
        error: `Companion registration preview hash mismatch: expected ${preview.preview_hash}, got ${previewHash}.`,
      };
    }

    const appliedTargets: string[] = [];
    for (const file of preview.files) {
      await fsp.mkdir(path.dirname(file.path), { recursive: true });
      await fsp.writeFile(file.path, file.content, "utf-8");
      appliedTargets.push(file.path);
    }

    return {
      success: true,
      preview_id: previewHash,
      applied_targets: appliedTargets,
      message: `Amp companion MCP registration applied successfully to ${appliedTargets.join(", ")}.`,
    };
  }

  /**
   * Validates companion registration status.
   */
  async validateCompanionRegistration(workspaceRoot?: string): Promise<ValidationResult> {
    const status = await this.inspectCompanionRegistration(workspaceRoot);
    return {
      valid: status.registered,
      workspace: workspaceRoot,
      message: status.registered
        ? `Amp companion registered at ${status.target_file}`
        : "Amp companion is not registered",
      details: status,
    };
  }

  /**
   * Previews configuration changes for an execution plan.
   */
  async previewConfiguration(
    plan: ExecutionConfig,
    profile?: AgentProfile,
    workspaceRoot?: string
  ): Promise<RenderedConfiguration> {
    return this.renderConfiguration(plan, profile, workspaceRoot);
  }

  /**
   * Renders configuration changes, diff, and mutation files without touching the filesystem.
   */
  async renderConfiguration(
    plan: ExecutionConfig,
    profile?: AgentProfile,
    workspaceRoot?: string
  ): Promise<RenderedConfiguration> {
    const workspace = workspaceRoot || process.cwd();
    const targetFile = this.determineTargetConfigPath(workspace);

    const targetModel =
      plan.execution?.model ||
      plan.controller?.model ||
      profile?.single_model?.model;

    if (!targetModel) {
      throw new Error(
        "Execution plan or profile does not specify a model for execution."
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
    let initialText = "{\n}\n";

    if (fs.existsSync(targetFile)) {
      existingContent = await fsp.readFile(targetFile, "utf-8");
      const parseErrors: jsonc.ParseError[] = [];
      jsonc.parse(existingContent, parseErrors, { allowTrailingComma: true });
      if (parseErrors.length > 0) {
        throw new Error(
          `Amp configuration file at '${targetFile}' contains syntax errors. Rejecting mutation to prevent configuration loss.`
        );
      }
      initialText = existingContent;
    }

    const formatting = { formattingOptions: { insertSpaces: true, tabSize: 2 } };
    let currentText = initialText;

    // 1. Update model
    const modelEdits = jsonc.modify(currentText, ["model"], targetModel, formatting);
    currentText = jsonc.applyEdits(currentText, modelEdits);

    // 2. Update reasoning effort if specified
    if (targetEffort) {
      const effortEdits = jsonc.modify(
        currentText,
        ["reasoning_effort"],
        targetEffort,
        formatting
      );
      currentText = jsonc.applyEdits(currentText, effortEdits);
    }

    // 3. Work items / subagents update
    if (plan.work_items && plan.work_items.length > 0) {
      for (const item of plan.work_items) {
        const agentEdits = jsonc.modify(
          currentText,
          ["agents", item.ticket_id],
          {
            model: item.model,
            ...(item.effort || item.effort_policy
              ? { reasoning_effort: item.effort || item.effort_policy }
              : {}),
          },
          formatting
        );
        currentText = jsonc.applyEdits(currentText, agentEdits);
      }
    }

    const files: RenderedFile[] = [
      {
        path: targetFile,
        content: currentText,
      },
    ];

    const diff = createUnifiedDiff(targetFile, existingContent, currentText);
    const previewId = `preview-amp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    return {
      preview_id: previewId,
      mutation_targets: files.map((f) => f.path),
      diff,
      files,
    };
  }

  /**
   * Applies rendered configuration changes to the filesystem.
   */
  async applyConfiguration(
    previewId: string,
    rendered?: RenderedConfiguration,
    _workspaceRoot?: string
  ): Promise<ApplyResult> {
    if (!rendered || !rendered.files || rendered.files.length === 0) {
      return {
        success: false,
        preview_id: previewId,
        applied_targets: [],
        error: "No rendered files provided in preview to apply.",
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

    const appliedTargets: string[] = [];
    for (const file of rendered.files) {
      await fsp.mkdir(path.dirname(file.path), { recursive: true });
      await fsp.writeFile(file.path, file.content, "utf-8");
      appliedTargets.push(file.path);
    }

    return {
      success: true,
      preview_id: previewId,
      applied_targets: appliedTargets,
      message: `Amp configuration applied successfully to ${appliedTargets.length} target(s).`,
    };
  }

  /**
   * Validates workspace configuration against expected plan.
   */
  async validateConfiguration(
    expected: ExecutionConfig,
    workspaceRoot?: string
  ): Promise<ValidationResult> {
    const workspace = workspaceRoot || process.cwd();
    const targetFile = this.determineTargetConfigPath(workspace);

    if (!fs.existsSync(targetFile)) {
      return {
        valid: false,
        workspace,
        message: `Amp configuration file '${targetFile}' does not exist.`,
        errors: [`Missing configuration file: ${targetFile}`],
      };
    }

    let parsed: any;
    try {
      const content = await fsp.readFile(targetFile, "utf-8");
      parsed = jsonc.parse(content);
    } catch (e: any) {
      return {
        valid: false,
        workspace,
        message: `Amp configuration file '${targetFile}' is invalid: ${e.message}`,
        errors: [e.message],
      };
    }

    const errors: string[] = [];
    const expectedModel = expected.execution?.model || expected.controller?.model;

    if (expectedModel && parsed?.model !== expectedModel) {
      errors.push(`Model mismatch: expected '${expectedModel}', got '${parsed?.model}'`);
    }

    if (expected.work_items && expected.work_items.length > 0) {
      for (const item of expected.work_items) {
        const itemModel = parsed?.agents?.[item.ticket_id]?.model;
        if (itemModel !== item.model) {
          errors.push(
            `Agent '${item.ticket_id}' model mismatch: expected '${item.model}', got '${itemModel}'`
          );
        }
      }
    }

    return {
      valid: errors.length === 0,
      workspace,
      message:
        errors.length === 0
          ? "Amp configuration matches expected plan."
          : `Amp configuration validation failed: ${errors.join("; ")}`,
      errors: errors.length > 0 ? errors : undefined,
      details: parsed,
    };
  }

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
