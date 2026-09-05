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

/**
 * Supported Zed agent execution paths (§38).
 */
export type ZedAgentPath = "zed-agent" | "external-acp" | "terminal-thread";

/**
 * Zed Native Adapter supporting editor-class agent workflows, agent profiles,
 * LLM providers, explicit agent execution paths (Zed native Agent, external ACP, terminal thread),
 * context servers (MCP), and safe configuration lifecycles (§38).
 */
export class ZedAdapter implements HostAdapter {
  readonly id = "zed";
  readonly name = "Zed Adapter";

  /**
   * Detects active Zed runtime environment from process environment or ancestry.
   */
  hasActiveRuntimeContext(_workspaceRoot?: string): boolean {
    if (
      (process.env.ZED_AGENT && process.env.ZED_AGENT !== "undefined") ||
      (process.env.ZED_APP && process.env.ZED_APP !== "undefined") ||
      (process.env.ZED_WINDOW_ID && process.env.ZED_WINDOW_ID !== "undefined") ||
      (process.env.ZED_PID && process.env.ZED_PID !== "undefined") ||
      (process.env.ZED_TERM && process.env.ZED_TERM !== "undefined") ||
      (process.env.ZED_PATH && process.env.ZED_PATH !== "undefined") ||
      (process.env.ZED_SESSION_ID && process.env.ZED_SESSION_ID !== "undefined") ||
      (process.env.ZED_HOME && process.env.ZED_HOME !== "undefined") ||
      (process.env.ZED_VERSION && process.env.ZED_VERSION !== "undefined")
    ) {
      return true;
    }
    if (process.env._ && path.basename(process.env._).toLowerCase().includes("zed")) {
      return true;
    }
    if (process.title && path.basename(process.title).toLowerCase().includes("zed")) {
      return true;
    }
    return false;
  }

  /**
   * Explicitly resolves which Zed agent path is active or being configured (§38).
   * Distinguishes:
   * - "zed-agent": Zed native Agent (editor internal agent, default)
   * - "external-acp": External Agent over ACP (Anthropic/OpenAI ACP)
   * - "terminal-thread": Terminal Thread
   */
  getAgentPath(workspaceRoot?: string): ZedAgentPath {
    if (process.env.ZED_AGENT_PATH) {
      const val = process.env.ZED_AGENT_PATH.toLowerCase().trim();
      if (val === "external-acp" || val === "acp") return "external-acp";
      if (val === "terminal-thread" || val === "terminal") return "terminal-thread";
      if (val === "zed-agent" || val === "agent" || val === "native") return "zed-agent";
    }

    const config = this.readEffectiveConfig(workspaceRoot);
    if (config) {
      if (config.agent_path) {
        const val = String(config.agent_path).toLowerCase().trim();
        if (val === "external-acp" || val === "acp") return "external-acp";
        if (val === "terminal-thread" || val === "terminal") return "terminal-thread";
        if (val === "zed-agent" || val === "agent" || val === "native") return "zed-agent";
      }
      if (config.assistant && config.assistant.agent_path) {
        const val = String(config.assistant.agent_path).toLowerCase().trim();
        if (val === "external-acp" || val === "acp") return "external-acp";
        if (val === "terminal-thread" || val === "terminal") return "terminal-thread";
        if (val === "zed-agent" || val === "agent" || val === "native") return "zed-agent";
      }
    }

    return "zed-agent";
  }

  /**
   * Identifies if Zed is the host harness for this workspace.
   */
  async identifyHost(workspaceRoot?: string): Promise<boolean> {
    if (this.hasActiveRuntimeContext(workspaceRoot)) {
      return true;
    }

    if (workspaceRoot) {
      const candidates = [
        path.join(workspaceRoot, ".zed"),
        path.join(workspaceRoot, ".zed", "settings.json"),
        path.join(workspaceRoot, ".zed", "tasks.json"),
        path.join(workspaceRoot, ".zed", "keymap.json"),
      ];
      if (candidates.some((p) => fs.existsSync(p))) {
        return true;
      }
    }

    if (process.env.ZED_HOME && fs.existsSync(process.env.ZED_HOME)) {
      return true;
    }

    if (!workspaceRoot) {
      const userCandidates = [
        path.join(os.homedir(), ".config", "zed"),
        path.join(os.homedir(), ".config", "zed", "settings.json"),
        path.join(os.homedir(), "Library", "Application Support", "Zed", "settings.json"),
      ];
      return userCandidates.some((p) => fs.existsSync(p));
    }

    return false;
  }

  /**
   * Inspects Zed host version and determines compatibility.
   */
  async inspectVersion(workspaceRoot?: string): Promise<HostVersionInfo> {
    let version = process.env.ZED_VERSION;
    let raw: string | undefined = version;

    if (!version && workspaceRoot) {
      const versionFile = path.join(workspaceRoot, ".zed", "version");
      if (fs.existsSync(versionFile)) {
        try {
          raw = fs.readFileSync(versionFile, "utf-8").trim();
          version = raw;
        } catch {
          // Skip
        }
      } else {
        const settingsFile = path.join(workspaceRoot, ".zed", "settings.json");
        if (fs.existsSync(settingsFile)) {
          try {
            const parsed = jsonc.parse(fs.readFileSync(settingsFile, "utf-8"));
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
      const userCandidates = [
        path.join(os.homedir(), ".config", "zed", "version"),
        path.join(os.homedir(), "Library", "Application Support", "Zed", "version"),
      ];
      for (const vp of userCandidates) {
        if (fs.existsSync(vp)) {
          try {
            raw = fs.readFileSync(vp, "utf-8").trim();
            version = raw;
            break;
          } catch {
            // Skip
          }
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
    return path.join(workspaceRoot, ".zed", "settings.json");
  }

  /**
   * Determines target user configuration file.
   */
  getUserConfigPath(): string {
    const configDir = path.join(os.homedir(), ".config", "zed");
    const settings = path.join(configDir, "settings.json");
    if (fs.existsSync(settings)) return settings;

    const macSettings = path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "Zed",
      "settings.json"
    );
    if (fs.existsSync(macSettings)) return macSettings;

    return settings;
  }

  private readEffectiveConfig(workspaceRoot?: string): Record<string, any> | null {
    if (workspaceRoot) {
      const p = path.join(workspaceRoot, ".zed", "settings.json");
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

    const userSettings = this.getUserConfigPath();
    if (fs.existsSync(userSettings)) {
      try {
        const content = fs.readFileSync(userSettings, "utf-8");
        const parsed = jsonc.parse(content);
        if (parsed && typeof parsed === "object") return parsed;
      } catch {
        // Skip
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
    const agentPath = this.getAgentPath(workspaceRoot);

    // Concurrency detection
    let concurrencyLimit: number | undefined;
    let concurrencyState: "available" | "unknown" = "unknown";

    if (process.env.ZED_MAX_CONCURRENCY) {
      const parsed = parseInt(process.env.ZED_MAX_CONCURRENCY, 10);
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
      } else if (
        config.assistant &&
        typeof config.assistant.concurrency === "number" &&
        config.assistant.concurrency > 0
      ) {
        concurrencyLimit = config.assistant.concurrency;
        concurrencyState = "available";
      }
    }

    // Subagent / profiles detection (§38)
    let subagentsState: "available" | "unknown" = "unknown";
    let subagentsLocator: string | undefined;

    if (
      config &&
      config.assistant &&
      config.assistant.profiles &&
      typeof config.assistant.profiles === "object" &&
      Object.keys(config.assistant.profiles).length > 0
    ) {
      subagentsState = "available";
      subagentsLocator = ".zed/settings.json#assistant.profiles";
    }

    const perAgentModelSelectionState: "available" | "unknown" =
      subagentsState === "available" ? "available" : "unknown";

    const reasoningState: "available" | "unknown" =
      effortValues.length > 0 ? "available" : "unknown";

    const targetConfigPath = workspaceRoot
      ? this.determineTargetConfigPath(workspaceRoot)
      : this.getUserConfigPath();

    return {
      host_id: "zed",
      adapter_id: "zed",
      workspace: workspaceRoot,
      observed_at: new Date().toISOString(),
      platform: `${os.platform()}-${os.arch()}`,
      available_models: models,
      supported_effort_values: effortValues,
      default_effort_value: effortValues.length > 0 ? effortValues[0] : undefined,
      capabilities: {
        subagents: {
          state: subagentsState,
          ...(subagentsLocator
            ? {
                evidence: {
                  kind: "host-config",
                  locator: subagentsLocator,
                },
              }
            : {}),
        },
        threads: {
          state: "available",
          evidence: {
            kind: "host-runtime",
            locator: `zed-${agentPath}-runtime`,
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
                  locator: subagentsLocator || ".zed/settings.json",
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
          supports_session_mutation: false,
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
   * Inspects configured models across Zed Assistant default model, profiles,
   * and language_models provider registries without fabricating unevidenced inventories.
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

    const processSettingsObj = (parsed: any, sourcePath: string) => {
      if (!parsed || typeof parsed !== "object") return;

      // 1. Assistant default_model
      if (parsed.assistant?.default_model) {
        const dm = parsed.assistant.default_model;
        if (typeof dm === "string") {
          addModel(dm, dm, `${sourcePath}#assistant.default_model`);
        } else if (dm && typeof dm === "object" && typeof dm.model === "string") {
          const label = dm.provider ? `${dm.provider}/${dm.model}` : dm.model;
          addModel(dm.model, label, `${sourcePath}#assistant.default_model`);
        }
      }

      // 2. Assistant profiles
      if (parsed.assistant?.profiles && typeof parsed.assistant.profiles === "object") {
        for (const [profileName, prof] of Object.entries(parsed.assistant.profiles)) {
          if (prof && typeof prof === "object") {
            const p = prof as any;
            if (typeof p.model === "string") {
              const label = p.provider
                ? `${profileName}: ${p.provider}/${p.model}`
                : `${profileName}: ${p.model}`;
              addModel(p.model, label, `${sourcePath}#assistant.profiles.${profileName}`);
            }
          }
        }
      }

      // 3. Language models providers (e.g. openai, anthropic, ollama)
      if (parsed.language_models && typeof parsed.language_models === "object") {
        for (const [providerName, provConfig] of Object.entries(parsed.language_models)) {
          if (provConfig && typeof provConfig === "object") {
            const pc = provConfig as any;
            if (Array.isArray(pc.available_models)) {
              for (const m of pc.available_models) {
                if (typeof m === "string") {
                  addModel(m, `${providerName}/${m}`, `${sourcePath}#language_models.${providerName}`);
                } else if (m && typeof m.name === "string") {
                  addModel(
                    m.name,
                    `${providerName}/${m.display_name || m.name}`,
                    `${sourcePath}#language_models.${providerName}`
                  );
                }
              }
            }
          }
        }
      }
    };

    // 1. Workspace settings
    if (workspaceRoot) {
      const workspaceSettings = path.join(workspaceRoot, ".zed", "settings.json");
      if (fs.existsSync(workspaceSettings)) {
        try {
          const parsed = jsonc.parse(fs.readFileSync(workspaceSettings, "utf-8"));
          processSettingsObj(parsed, workspaceSettings);
        } catch {
          // Skip
        }
      }
    }

    // 2. User settings fallback
    const userSettings = this.getUserConfigPath();
    if (fs.existsSync(userSettings)) {
      try {
        const parsed = jsonc.parse(fs.readFileSync(userSettings, "utf-8"));
        processSettingsObj(parsed, userSettings);
      } catch {
        // Skip
      }
    }

    // 3. Environment override
    if (process.env.ZED_MODEL) {
      addModel(process.env.ZED_MODEL, process.env.ZED_MODEL, "process.env.ZED_MODEL");
    }

    return models;
  }

  /**
   * Inspects supported reasoning effort values. Returns empty array if unevidenced.
   */
  async inspectEffortValues(workspaceRoot?: string): Promise<string[]> {
    const config = this.readEffectiveConfig(workspaceRoot);
    if (config) {
      if (config.assistant && Array.isArray(config.assistant.supported_effort_values)) {
        return config.assistant.supported_effort_values.map(String);
      }
      if (config.assistant && typeof config.assistant.reasoning_effort === "string") {
        return [config.assistant.reasoning_effort];
      }
      if (Array.isArray(config.supported_effort_values)) {
        return config.supported_effort_values.map(String);
      }
      if (typeof config.reasoning_effort === "string") {
        return [config.reasoning_effort];
      }
    }

    if (process.env.ZED_REASONING_EFFORT) {
      return [process.env.ZED_REASONING_EFFORT];
    }

    return [];
  }

  /**
   * Inspects native reasoning options for Zed.
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
   * Resolves abstract reasoning policy to Zed native representation.
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
      if (values.includes("high")) selectedValue = "high";
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
   * Inspects execution topology capabilities for Zed.
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
   * Inspects companion registration in Zed context_servers (§38).
   */
  async inspectCompanionRegistration(
    workspaceRoot?: string,
    scope?: "project" | "global" | "user"
  ): Promise<CompanionRegistrationStatus> {
    const workspace = workspaceRoot || process.cwd();

    // 1. Workspace scope (.zed/settings.json)
    const workspaceSettings = path.join(workspace, ".zed", "settings.json");
    if (fs.existsSync(workspaceSettings)) {
      try {
        const content = fs.readFileSync(workspaceSettings, "utf-8");
        const parsed = jsonc.parse(content);
        const serverConfig =
          parsed?.context_servers?.["agent-config"] ||
          parsed?.mcpServers?.["agent-config"];
        if (serverConfig) {
          return {
            registered: true,
            transport: "stdio",
            scope: "project",
            locator: workspaceSettings,
            command: serverConfig.command,
            args: serverConfig.args,
            target_file: workspaceSettings,
            details: { scope: "workspace", config: serverConfig },
          };
        }
      } catch {
        // Skip
      }
    }

    // 2. User scope
    const userSettings = this.getUserConfigPath();
    if (fs.existsSync(userSettings)) {
      try {
        const content = fs.readFileSync(userSettings, "utf-8");
        const parsed = jsonc.parse(content);
        const serverConfig =
          parsed?.context_servers?.["agent-config"] ||
          parsed?.mcpServers?.["agent-config"];
        if (serverConfig) {
          return {
            registered: true,
            transport: "stdio",
            scope: "global",
            locator: userSettings,
            command: serverConfig.command,
            args: serverConfig.args,
            target_file: userSettings,
            details: { scope: "user", config: serverConfig },
          };
        }
      } catch {
        // Skip
      }
    }

    const defaultTarget = this.determineTargetConfigPath(workspace);
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
   * Previews companion registration into Zed context_servers.
   */
  async previewCompanionRegistration(
    workspaceRoot?: string,
    scope?: "project" | "global" | "user"
  ): Promise<CompanionRegistrationPreview> {
    const workspace = workspaceRoot || process.cwd();
    const targetFile = this.determineTargetConfigPath(workspace);
    const resolvedScope: "project" | "global" =
      scope === "global" || scope === "user" || (!scope && !workspaceRoot)
        ? "global"
        : "project";

    let existingContent: string | null = null;
    let initialText = "{\n  \"context_servers\": {}\n}\n";

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
          error: `Zed settings file at '${targetFile}' contains syntax errors. Rejecting companion registration to prevent loss.`,
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
      ["context_servers", "agent-config"],
      { command: "agent-config", args: ["serve"] },
      formatting
    );
    const newContent = jsonc.applyEdits(initialText, edits);

    const diff = createUnifiedDiff(targetFile, existingContent, newContent);
    const previewId = `preview-companion-zed-${Date.now()}`;
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
        error: preview.error || "Cannot apply companion registration for Zed.",
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
      message: `Zed context_servers companion registration applied successfully to ${appliedTargets.join(", ")}.`,
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
        ? `Zed companion registered at ${status.target_file}`
        : "Zed companion is not registered in context_servers",
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
   * Renders Zed settings configuration changes, diff, and mutation files without touching the filesystem.
   * Explicitly notes configured agent path (§38).
   */
  async renderConfiguration(
    plan: ExecutionConfig,
    profile?: AgentProfile,
    workspaceRoot?: string
  ): Promise<RenderedConfiguration> {
    const workspace = workspaceRoot || process.cwd();
    const targetFile = this.determineTargetConfigPath(workspace);
    const agentPath = this.getAgentPath(workspace);

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
          `Zed settings file at '${targetFile}' contains syntax errors. Rejecting mutation to prevent configuration loss.`
        );
      }
      initialText = existingContent;
    }

    const formatting = { formattingOptions: { insertSpaces: true, tabSize: 2 } };
    let currentText = initialText;

    // 1. Update assistant.default_model
    // Inspect existing structure to retain provider if present
    let existingProvider = "zed.dev";
    try {
      const parsed = jsonc.parse(initialText);
      if (parsed?.assistant?.default_model?.provider) {
        existingProvider = parsed.assistant.default_model.provider;
      }
    } catch {
      // Ignore
    }

    const defaultModelVal = {
      provider: existingProvider,
      model: targetModel,
    };

    const modelEdits = jsonc.modify(
      currentText,
      ["assistant", "default_model"],
      defaultModelVal,
      formatting
    );
    currentText = jsonc.applyEdits(currentText, modelEdits);

    // 2. Update reasoning effort if specified
    if (targetEffort) {
      const effortEdits = jsonc.modify(
        currentText,
        ["assistant", "reasoning_effort"],
        targetEffort,
        formatting
      );
      currentText = jsonc.applyEdits(currentText, effortEdits);
    }

    // 3. Work items rendered into assistant.profiles (§38)
    if (plan.work_items && plan.work_items.length > 0) {
      for (const item of plan.work_items) {
        const profileVal: Record<string, any> = {
          model: item.model,
        };
        if (item.effort || item.effort_policy) {
          profileVal.reasoning_effort = item.effort || item.effort_policy;
        }
        const profileEdits = jsonc.modify(
          currentText,
          ["assistant", "profiles", item.ticket_id],
          profileVal,
          formatting
        );
        currentText = jsonc.applyEdits(currentText, profileEdits);
      }
    }

    const files: RenderedFile[] = [
      {
        path: targetFile,
        content: currentText,
      },
    ];

    const diff = createUnifiedDiff(targetFile, existingContent, currentText);
    const previewId = `preview-zed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    return {
      preview_id: previewId,
      mutation_targets: files.map((f) => f.path),
      diff,
      files,
      raw: {
        configured_agent_path: agentPath,
      },
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
      message: `Zed settings applied successfully to ${appliedTargets.length} target(s).`,
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
        message: `Zed settings file '${targetFile}' does not exist.`,
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
        message: `Zed settings file '${targetFile}' is invalid: ${e.message}`,
        errors: [e.message],
      };
    }

    const errors: string[] = [];
    const expectedModel = expected.execution?.model || expected.controller?.model;

    if (expectedModel) {
      const actualModel =
        typeof parsed?.assistant?.default_model === "string"
          ? parsed.assistant.default_model
          : parsed?.assistant?.default_model?.model;

      if (actualModel !== expectedModel) {
        errors.push(`Model mismatch: expected '${expectedModel}', got '${actualModel}'`);
      }
    }

    if (expected.work_items && expected.work_items.length > 0) {
      for (const item of expected.work_items) {
        const itemModel = parsed?.assistant?.profiles?.[item.ticket_id]?.model;
        if (itemModel !== item.model) {
          errors.push(
            `Profile '${item.ticket_id}' model mismatch: expected '${item.model}', got '${itemModel}'`
          );
        }
      }
    }

    return {
      valid: errors.length === 0,
      workspace,
      message:
        errors.length === 0
          ? "Zed configuration matches expected plan."
          : `Zed configuration validation failed: ${errors.join("; ")}`,
      errors: errors.length > 0 ? errors : undefined,
      details: {
        agent_path: this.getAgentPath(workspace),
        settings: parsed,
      },
    };
  }
}
