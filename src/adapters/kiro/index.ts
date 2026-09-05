import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
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

export type KiroSurfaceMode = "ide" | "cli" | "unified";

/**
 * Kiro Native Adapter supporting unified IDE/CLI surface inspection with
 * surface capability distinction, workspace/user/agent MCP scoping,
 * model and subagent availability, and safe configuration lifecycle (§37).
 */
export class KiroAdapter implements HostAdapter {
  readonly id = "kiro";
  readonly name = "Kiro Adapter";

  /**
   * Detects active Kiro runtime environment from process environment or ancestry.
   */
  hasActiveRuntimeContext(_workspaceRoot?: string): boolean {
    if (
      process.env.KIRO_IDE === "1" ||
      process.env.KIRO_IDE === "true" ||
      process.env.KIRO_CLI === "1" ||
      process.env.KIRO_CLI === "true" ||
      (process.env.KIRO_SESSION && process.env.KIRO_SESSION !== "undefined") ||
      (process.env.KIRO_SESSION_ID && process.env.KIRO_SESSION_ID !== "undefined") ||
      (process.env.KIRO_AGENT && process.env.KIRO_AGENT !== "undefined") ||
      (process.env.KIRO_HOME && process.env.KIRO_HOME !== "undefined") ||
      (process.env.KIRO_CONFIG_DIR && process.env.KIRO_CONFIG_DIR !== "undefined") ||
      (process.env.KIRO_VERSION && process.env.KIRO_VERSION !== "undefined")
    ) {
      return true;
    }
    if (process.env._ && path.basename(process.env._).toLowerCase().includes("kiro")) {
      return true;
    }
    if (process.title && path.basename(process.title).toLowerCase().includes("kiro")) {
      return true;
    }
    return false;
  }

  /**
   * Distinguishes surface mode: IDE, CLI, or unified.
   */
  getSurfaceMode(workspaceRoot?: string): KiroSurfaceMode {
    if (process.env.KIRO_IDE === "1" || process.env.KIRO_IDE === "true") {
      return "ide";
    }
    if (process.env.KIRO_CLI === "1" || process.env.KIRO_CLI === "true") {
      return "cli";
    }
    if (workspaceRoot) {
      if (fs.existsSync(path.join(workspaceRoot, ".kiro", "ide"))) {
        return "ide";
      }
      if (fs.existsSync(path.join(workspaceRoot, ".kiro", "cli"))) {
        return "cli";
      }
    }
    return "unified";
  }

  /**
   * Identifies if Kiro is the host harness for this workspace.
   */
  async identifyHost(workspaceRoot?: string): Promise<boolean> {
    if (this.hasActiveRuntimeContext(workspaceRoot)) {
      return true;
    }

    if (workspaceRoot) {
      const candidates = [
        path.join(workspaceRoot, ".kiro"),
        path.join(workspaceRoot, ".kiro", "config.json"),
        path.join(workspaceRoot, ".kiro", "settings.json"),
        path.join(workspaceRoot, ".kiro", "mcp.json"),
        path.join(workspaceRoot, "kiro.json"),
        path.join(workspaceRoot, ".kiro.json"),
      ];
      if (candidates.some((p) => fs.existsSync(p))) {
        return true;
      }
    }

    if (process.env.KIRO_HOME && fs.existsSync(process.env.KIRO_HOME)) {
      return true;
    }

    if (!workspaceRoot) {
      const userCandidates = [
        path.join(os.homedir(), ".kiro"),
        path.join(os.homedir(), ".config", "kiro"),
        path.join(os.homedir(), ".kiro.json"),
      ];
      return userCandidates.some((p) => fs.existsSync(p));
    }

    return false;
  }

  /**
   * Inspects Kiro host version and determines compatibility.
   */
  async inspectVersion(workspaceRoot?: string): Promise<HostVersionInfo> {
    let version = process.env.KIRO_VERSION;
    let raw: string | undefined = version;

    if (!version && workspaceRoot) {
      const versionFile = path.join(workspaceRoot, ".kiro", "version");
      if (fs.existsSync(versionFile)) {
        try {
          raw = fs.readFileSync(versionFile, "utf-8").trim();
          version = raw;
        } catch {
          // Skip
        }
      } else {
        const configFile = path.join(workspaceRoot, ".kiro", "config.json");
        if (fs.existsSync(configFile)) {
          try {
            const parsed = jsonc.parse(fs.readFileSync(configFile, "utf-8"));
            if (parsed && typeof parsed.version === "string") {
              version = parsed.version;
              raw = parsed.version;
            }
          } catch {
            // Skip
          }
        }
      }
    }

    if (!version) {
      const userVersionFile = path.join(os.homedir(), ".kiro", "version");
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
    const kiroDir = path.join(workspaceRoot, ".kiro");
    const configFile = path.join(kiroDir, "config.json");
    if (fs.existsSync(configFile)) return configFile;

    const settingsFile = path.join(kiroDir, "settings.json");
    if (fs.existsSync(settingsFile)) return settingsFile;

    const rootKiroJson = path.join(workspaceRoot, "kiro.json");
    if (fs.existsSync(rootKiroJson)) return rootKiroJson;

    return configFile;
  }

  /**
   * Determines target MCP registration file path.
   */
  determineMcpRegistrationPath(workspaceRoot: string): string {
    const mcpFile = path.join(workspaceRoot, ".kiro", "mcp.json");
    if (fs.existsSync(mcpFile)) return mcpFile;

    const configFile = path.join(workspaceRoot, ".kiro", "config.json");
    if (fs.existsSync(configFile)) return configFile;

    return configFile;
  }

  private readEffectiveConfig(workspaceRoot?: string): Record<string, any> | null {
    if (workspaceRoot) {
      const candidates = [
        path.join(workspaceRoot, ".kiro", "config.json"),
        path.join(workspaceRoot, ".kiro", "settings.json"),
        path.join(workspaceRoot, "kiro.json"),
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
      path.join(os.homedir(), ".kiro", "config.json"),
      path.join(os.homedir(), ".config", "kiro", "config.json"),
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
    const surfaceMode = this.getSurfaceMode(workspaceRoot);

    // Concurrency detection
    let concurrencyLimit: number | undefined;
    let concurrencyState: "available" | "unknown" = "unknown";

    if (process.env.KIRO_MAX_CONCURRENCY) {
      const parsed = parseInt(process.env.KIRO_MAX_CONCURRENCY, 10);
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

    // Subagent / per-agent model selection detection
    let subagentsState: "available" | "unknown" = "unknown";
    let subagentsEvidenceLocator: string | undefined;

    if (workspaceRoot) {
      const agentsDir = path.join(workspaceRoot, ".kiro", "agents");
      if (fs.existsSync(agentsDir)) {
        subagentsState = "available";
        subagentsEvidenceLocator = ".kiro/agents";
      }
    }

    if (subagentsState === "unknown" && config && config.agents && typeof config.agents === "object") {
      if (Object.keys(config.agents).length > 0) {
        subagentsState = "available";
        subagentsEvidenceLocator = ".kiro/config.json#agents";
      }
    }

    const perAgentModelSelectionState: "available" | "unknown" =
      subagentsState === "available" ? "available" : "unknown";

    const reasoningState: "available" | "unknown" =
      effortValues.length > 0 ? "available" : "unknown";

    const targetConfigPath = workspaceRoot
      ? this.determineTargetConfigPath(workspaceRoot)
      : path.join(os.homedir(), ".kiro", "config.json");

    return {
      host_id: "kiro",
      adapter_id: "kiro",
      workspace: workspaceRoot,
      observed_at: new Date().toISOString(),
      platform: `${os.platform()}-${os.arch()}`,
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
          state: "available",
          evidence: {
            kind: "host-runtime",
            locator: `kiro-${surfaceMode}-session-runtime`,
          },
        },
        parallelism: {
          state: concurrencyState === "available" ? "available" : "unknown",
          ...(concurrencyState === "available"
            ? {
                evidence: {
                  kind: "host-config",
                  locator: targetConfigPath,
                },
              }
            : {}),
        },
        model_selection: {
          state: "available",
          scopes: ["current-session", "new-session", "per-agent"],
          evidence: {
            kind: "host-config",
            locator: targetConfigPath,
          },
        },
        per_agent_model_selection: {
          state: perAgentModelSelectionState,
          ...(perAgentModelSelectionState === "available"
            ? {
                evidence: {
                  kind: "host-config",
                  locator: subagentsEvidenceLocator || ".kiro/config.json",
                },
              }
            : {}),
        },
        concurrency: {
          state: concurrencyState,
          max_concurrency: concurrencyLimit,
          ...(concurrencyState === "available"
            ? {
                evidence: {
                  kind: "host-config",
                  locator: targetConfigPath,
                },
              }
            : {}),
        },
        configuration_mutation: {
          state: "available",
          supports_native_files: true,
          supports_session_mutation: surfaceMode === "ide",
          evidence: {
            kind: "host-config",
            locator: targetConfigPath,
          },
        },
        reasoning: {
          state: reasoningState,
          ...(reasoningState === "available"
            ? {
                evidence: {
                  kind: "host-config",
                  locator: targetConfigPath,
                },
              }
            : {}),
        },
      },
    };
  }

  /**
   * Inspects configured models without fabricating unevidenced inventories.
   */
  async inspectModels(workspaceRoot?: string): Promise<HostModel[]> {
    const models: HostModel[] = [];
    const seen = new Set<string>();

    const addModel = (id: string, label: string, locator: string) => {
      if (!id || seen.has(id)) return;
      seen.add(id);
      models.push({
        id,
        label,
        state: "available",
        features: ["tools"],
        evidence: {
          kind: "host-config",
          locator,
        },
      });
    };

    // 1. Workspace configs
    if (workspaceRoot) {
      const candidates = [
        path.join(workspaceRoot, ".kiro", "config.json"),
        path.join(workspaceRoot, ".kiro", "settings.json"),
        path.join(workspaceRoot, "kiro.json"),
      ];
      for (const cp of candidates) {
        if (fs.existsSync(cp)) {
          try {
            const parsed = jsonc.parse(fs.readFileSync(cp, "utf-8"));
            if (parsed) {
              if (typeof parsed.model === "string") addModel(parsed.model, parsed.model, cp);
              if (typeof parsed.default_model === "string")
                addModel(parsed.default_model, parsed.default_model, cp);
              if (Array.isArray(parsed.supported_models)) {
                for (const m of parsed.supported_models) {
                  if (typeof m === "string") addModel(m, m, cp);
                }
              }
              if (Array.isArray(parsed.models)) {
                for (const m of parsed.models) {
                  if (typeof m === "string") addModel(m, m, cp);
                  else if (m && typeof m.id === "string") addModel(m.id, m.name || m.id, cp);
                }
              }
              if (parsed.agents && typeof parsed.agents === "object") {
                for (const agentKey of Object.keys(parsed.agents)) {
                  const ag = parsed.agents[agentKey];
                  if (ag && typeof ag.model === "string") {
                    addModel(ag.model, `${agentKey} (${ag.model})`, `${cp}#agents.${agentKey}`);
                  }
                }
              }
            }
          } catch {
            // Skip
          }
        }
      }

      // Workspace agent files (.kiro/agents/*.json)
      const agentsDir = path.join(workspaceRoot, ".kiro", "agents");
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
      path.join(os.homedir(), ".kiro", "config.json"),
      path.join(os.homedir(), ".config", "kiro", "config.json"),
    ];
    for (const cp of userConfigs) {
      if (fs.existsSync(cp)) {
        try {
          const parsed = jsonc.parse(fs.readFileSync(cp, "utf-8"));
          if (parsed) {
            if (typeof parsed.model === "string") addModel(parsed.model, parsed.model, cp);
            if (typeof parsed.default_model === "string")
              addModel(parsed.default_model, parsed.default_model, cp);
            if (Array.isArray(parsed.supported_models)) {
              for (const m of parsed.supported_models) {
                if (typeof m === "string") addModel(m, m, cp);
              }
            }
          }
        } catch {
          // Skip
        }
      }
    }

    // 3. Environment override
    if (process.env.KIRO_MODEL) {
      addModel(process.env.KIRO_MODEL, process.env.KIRO_MODEL, "process.env.KIRO_MODEL");
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
      if (config.thinking && typeof config.thinking === "object") {
        if (Array.isArray(config.thinking.supported_values)) {
          return config.thinking.supported_values.map(String);
        }
        if (config.thinking.type === "enabled" || config.thinking.budget_tokens) {
          return ["enabled", "disabled"];
        }
      }
    }

    if (process.env.KIRO_REASONING_EFFORT) {
      return [process.env.KIRO_REASONING_EFFORT];
    }

    return [];
  }

  /**
   * Inspects native reasoning options for Kiro.
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
   * Resolves abstract reasoning policy to Kiro native representation.
   */
  async resolveReasoningPolicy(
    policy: string,
    _modelId?: string,
    workspaceRoot?: string
  ): Promise<ResolvedReasoningPolicy | undefined> {
    const options = await this.inspectReasoningOptions(workspaceRoot);
    if (options.supported_values.length === 0) {
      return undefined;
    }

    const values = options.supported_values;
    const normalized = policy.toLowerCase().trim();

    let selectedValue: string | undefined;
    if (normalized === "highest-supported") {
      if (values.includes("xhigh")) selectedValue = "xhigh";
      else if (values.includes("high")) selectedValue = "high";
      else selectedValue = values[values.length - 1];
    } else if (normalized === "lowest-sufficient" || normalized === "lowest-supported") {
      if (values.includes("low")) selectedValue = "low";
      else selectedValue = values[0];
    } else if (normalized === "configured") {
      selectedValue = options.default_value || values[0];
    } else if (values.includes(policy)) {
      selectedValue = policy;
    }

    if (!selectedValue) return undefined;
    return {
      host_field: options.native_field,
      host_value: selectedValue,
    };
  }

  /**
   * Inspects execution topology capabilities for Kiro.
   */
  async inspectExecutionTopologyCapabilities(
    workspaceRoot?: string
  ): Promise<TopologyCapabilities> {
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
   * Inspects MCP companion registration across workspace, user, and agent scopes.
   */
  async inspectCompanionRegistration(
    workspaceRoot?: string,
    scope?: "project" | "global" | "user"
  ): Promise<CompanionRegistrationStatus> {
    const workspace = workspaceRoot || process.cwd();

    // 1. Workspace scope
    const workspaceMcpCandidates = [
      path.join(workspace, ".kiro", "mcp.json"),
      path.join(workspace, ".kiro", "config.json"),
      path.join(workspace, ".kiro", "settings.json"),
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
      path.join(os.homedir(), ".kiro", "mcp.json"),
      path.join(os.homedir(), ".kiro", "config.json"),
      path.join(os.homedir(), ".config", "kiro", "mcp.json"),
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

    // 3. Agent scope (.kiro/agents/*.json)
    const agentsDir = path.join(workspace, ".kiro", "agents");
    if (fs.existsSync(agentsDir)) {
      try {
        const entries = fs.readdirSync(agentsDir);
        for (const entry of entries) {
          if (entry.endsWith(".json")) {
            const agentFile = path.join(agentsDir, entry);
            try {
              const content = fs.readFileSync(agentFile, "utf-8");
              const parsed = jsonc.parse(content);
              const serverConfig = parsed?.mcpServers?.["agent-config"];
              if (serverConfig) {
                return {
                  registered: true,
                  transport: "stdio",
                  scope: "project",
                  locator: agentFile,
                  command: serverConfig.command,
                  args: serverConfig.args,
                  target_file: agentFile,
                  details: { scope: "agent", agent: entry, config: serverConfig },
                };
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
   * Previews companion registration into Kiro configuration.
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
          error: `Kiro configuration file at '${targetFile}' contains syntax errors. Rejecting companion registration to prevent loss.`,
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
    const previewId = `preview-companion-kiro-${Date.now()}`;
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
        error: preview.error || "Cannot apply companion registration for Kiro.",
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
      message: `Kiro companion MCP registration applied successfully to ${appliedTargets.join(", ")}.`,
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
        ? `Kiro companion registered at ${status.target_file}`
        : "Kiro companion is not registered",
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
          `Kiro configuration file at '${targetFile}' contains syntax errors. Rejecting mutation to prevent configuration loss.`
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
    const previewId = `preview-kiro-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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
      message: `Kiro configuration applied successfully to ${appliedTargets.length} target(s).`,
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
        message: `Kiro configuration file '${targetFile}' does not exist.`,
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
        message: `Kiro configuration file '${targetFile}' is invalid: ${e.message}`,
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
          ? "Kiro configuration matches expected plan."
          : `Kiro configuration validation failed: ${errors.join("; ")}`,
      errors: errors.length > 0 ? errors : undefined,
      details: parsed,
    };
  }
}
