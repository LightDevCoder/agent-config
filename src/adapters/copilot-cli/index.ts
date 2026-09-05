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

export interface CopilotCustomAgent {
  name: string;
  model?: string;
  description?: string;
  context?: string;
  isolated?: boolean;
  tools?: string[];
  mcpServers?: Record<string, any>;
  filePath: string;
}

export interface CopilotPromptPreset {
  name: string;
  prompt?: string;
  description?: string;
  filePath: string;
}

/**
 * GitHub Copilot CLI native adapter supporting custom agents, subagents with
 * isolated worker contexts (distinguished from simple prompt presets), repo vs user
 * configuration scopes, honest reasoning reporting, and native MCP configuration.
 */
export class CopilotCliAdapter implements HostAdapter {
  readonly id = "copilot-cli";
  readonly name = "GitHub Copilot CLI Adapter";

  hasActiveRuntimeContext(_workspaceRoot?: string): boolean {
    if (
      process.env.GITHUB_COPILOT_CLI === "1" ||
      process.env.GITHUB_COPILOT_CLI === "true" ||
      (process.env.COPILOT_CLI && process.env.COPILOT_CLI !== "undefined") ||
      (process.env.GITHUB_COPILOT && process.env.GITHUB_COPILOT !== "undefined") ||
      (process.env.COPILOT_SESSION_ID && process.env.COPILOT_SESSION_ID !== "undefined") ||
      (process.env.COPILOT_AGENT && process.env.COPILOT_AGENT !== "undefined") ||
      (process.env.GH_COPILOT && process.env.GH_COPILOT !== "undefined") ||
      (process.env.COPILOT_CONFIG_DIR && process.env.COPILOT_CONFIG_DIR !== "undefined")
    ) {
      return true;
    }
    if (
      process.env._ &&
      (path.basename(process.env._).toLowerCase().includes("copilot") ||
        path.basename(process.env._).toLowerCase().includes("gh-copilot"))
    ) {
      return true;
    }
    if (
      process.title &&
      (path.basename(process.title).toLowerCase().includes("copilot") ||
        path.basename(process.title).toLowerCase().includes("gh-copilot"))
    ) {
      return true;
    }
    return false;
  }

  async identifyHost(workspaceRoot?: string): Promise<boolean> {
    if (this.hasActiveRuntimeContext(workspaceRoot)) {
      return true;
    }

    if (workspaceRoot) {
      const candidates = [
        path.join(workspaceRoot, ".github", "copilot"),
        path.join(workspaceRoot, ".copilot"),
        path.join(workspaceRoot, ".copilot-cli"),
        path.join(workspaceRoot, ".github", "copilot.json"),
        path.join(workspaceRoot, "copilot.json"),
        path.join(workspaceRoot, ".copilot", "config.json"),
        path.join(workspaceRoot, ".github", "copilot", "config.json"),
        path.join(workspaceRoot, ".github", "copilot", "agents"),
        path.join(workspaceRoot, ".copilot", "agents"),
      ];
      if (candidates.some((p) => fs.existsSync(p))) {
        return true;
      }
    }

    if (process.env.COPILOT_CONFIG_DIR && fs.existsSync(process.env.COPILOT_CONFIG_DIR)) {
      return true;
    }

    if (!workspaceRoot) {
      const globalCandidates = [
        this.getGlobalCopilotDir(),
        path.join(os.homedir(), ".copilot"),
        path.join(os.homedir(), ".copilot-cli"),
        path.join(os.homedir(), ".config", "copilot"),
      ];
      return globalCandidates.some((p) => fs.existsSync(p));
    }

    return false;
  }

  async inspectVersion(workspaceRoot?: string): Promise<HostVersionInfo> {
    let version =
      process.env.COPILOT_VERSION || process.env.GITHUB_COPILOT_VERSION;
    let raw: string | undefined = version;

    if (!version && workspaceRoot) {
      const versionPaths = [
        path.join(workspaceRoot, ".github", "copilot", "version"),
        path.join(workspaceRoot, ".copilot", "version"),
      ];
      for (const vp of versionPaths) {
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
      const globalVersionFile = path.join(this.getGlobalCopilotDir(), "version");
      if (fs.existsSync(globalVersionFile)) {
        try {
          raw = fs.readFileSync(globalVersionFile, "utf-8").trim();
          version = raw;
        } catch {
          // Skip
        }
      }
    }

    if (!version) {
      const config = this.readEffectiveConfig(workspaceRoot);
      if (config && typeof config.version === "string") {
        version = config.version;
        raw = config.version;
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

  async inspectCapabilities(workspaceRoot?: string): Promise<HostCapabilities> {
    const models = await this.inspectModels(workspaceRoot);
    const effortValues = await this.inspectEffortValues(workspaceRoot);
    const { agents } = await this.inspectCustomAgentsAndPresets(workspaceRoot);

    // Concurrency: derive strictly from config or environment, else state is unknown
    let concurrencyLimit: number | undefined;
    let concurrencyState: "available" | "unknown" = "unknown";

    const config = this.readEffectiveConfig(workspaceRoot);
    if (config) {
      const parsedConcurrency =
        typeof config.concurrency === "number"
          ? config.concurrency
          : typeof config.max_concurrency === "number"
          ? config.max_concurrency
          : typeof config.parallel_workers === "number"
          ? config.parallel_workers
          : undefined;
      if (parsedConcurrency !== undefined && parsedConcurrency > 0) {
        concurrencyLimit = parsedConcurrency;
        concurrencyState = "available";
      }
    }

    if (!concurrencyLimit && process.env.COPILOT_MAX_CONCURRENCY) {
      const parsed = parseInt(process.env.COPILOT_MAX_CONCURRENCY, 10);
      if (!isNaN(parsed) && parsed > 0) {
        concurrencyLimit = parsed;
        concurrencyState = "available";
      }
    }

    // Subagents: verified custom agents with isolated worker contexts, or agents dir
    const hasWorkspaceAgentsDir = workspaceRoot
      ? fs.existsSync(path.join(workspaceRoot, ".github", "copilot", "agents")) ||
        fs.existsSync(path.join(workspaceRoot, ".copilot", "agents"))
      : false;
    const hasGlobalAgentsDir = fs.existsSync(
      path.join(this.getGlobalCopilotDir(), "agents")
    );
    const hasVerifiedAgents =
      agents.length > 0 || hasWorkspaceAgentsDir || hasGlobalAgentsDir;

    const subagentsState: "available" | "unknown" = hasVerifiedAgents
      ? "available"
      : "unknown";
    const subagentsEvidence = hasVerifiedAgents
      ? {
          kind: "host-config" as const,
          locator: hasWorkspaceAgentsDir
            ? ".github/copilot/agents"
            : hasGlobalAgentsDir
            ? "~/.config/github-copilot/agents"
            : "copilot custom agents",
        }
      : undefined;

    const perAgentModelSelectionState: "available" | "unknown" =
      subagentsState === "available" ? "available" : "unknown";

    const reasoningState: "available" | "unknown" =
      effortValues.length > 0 ? "available" : "unknown";

    const targetConfigPath = this.determineTargetConfigPath(
      workspaceRoot || process.cwd()
    );

    return {
      host_id: "copilot-cli",
      adapter_id: "copilot-cli",
      workspace: workspaceRoot,
      observed_at: new Date().toISOString(),
      platform: `${os.platform()}-${os.arch()}`,
      available_models: models,
      supported_effort_values: effortValues,
      default_effort_value:
        effortValues.length > 0 ? effortValues[0] : undefined,
      capabilities: {
        subagents: {
          state: subagentsState,
          ...(subagentsEvidence ? { evidence: subagentsEvidence } : {}),
        },
        threads: {
          state: "available",
          evidence: {
            kind: "host-runtime",
            locator: "copilot-cli session runtime",
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
                  locator: ".github/copilot/agents/*.json",
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

  async inspectModels(workspaceRoot?: string): Promise<HostModel[]> {
    const models: HostModel[] = [];
    const seen = new Set<string>();

    const addModel = (
      id: string,
      label: string,
      locator: string,
      features: string[] = ["tools"]
    ) => {
      if (!id || seen.has(id)) return;
      seen.add(id);
      models.push({
        id,
        label,
        state: "available",
        features,
        evidence: {
          kind: "host-config",
          locator,
        },
      });
    };

    // 1. Repo-level config (highest precedence for models)
    if (workspaceRoot) {
      const repoConfigs = [
        path.join(workspaceRoot, ".github", "copilot", "config.json"),
        path.join(workspaceRoot, ".copilot", "config.json"),
        path.join(workspaceRoot, "copilot.json"),
        path.join(workspaceRoot, ".github", "copilot.json"),
      ];
      for (const cp of repoConfigs) {
        if (fs.existsSync(cp)) {
          try {
            const parsed = jsonc.parse(fs.readFileSync(cp, "utf-8"));
            if (parsed && typeof parsed.model === "string") {
              addModel(parsed.model, parsed.model, cp);
            }
            if (parsed && typeof parsed.default_model === "string") {
              addModel(parsed.default_model, parsed.default_model, cp);
            }
            if (parsed && Array.isArray(parsed.models)) {
              for (const m of parsed.models) {
                if (typeof m === "string") addModel(m, m, cp);
                else if (m && typeof m.id === "string")
                  addModel(m.id, m.name || m.id, cp);
              }
            }
          } catch {
            // Skip
          }
        }
      }
    }

    // 2. User-level config
    const userConfigs = [
      path.join(this.getGlobalCopilotDir(), "config.json"),
      path.join(os.homedir(), ".copilot", "config.json"),
    ];
    for (const cp of userConfigs) {
      if (fs.existsSync(cp)) {
        try {
          const parsed = jsonc.parse(fs.readFileSync(cp, "utf-8"));
          if (parsed && typeof parsed.model === "string") {
            addModel(parsed.model, parsed.model, cp);
          }
          if (parsed && typeof parsed.default_model === "string") {
            addModel(parsed.default_model, parsed.default_model, cp);
          }
          if (parsed && Array.isArray(parsed.models)) {
            for (const m of parsed.models) {
              if (typeof m === "string") addModel(m, m, cp);
              else if (m && typeof m.id === "string")
                addModel(m.id, m.name || m.id, cp);
            }
          }
        } catch {
          // Skip
        }
      }
    }

    // 3. Custom agents
    const { agents } = await this.inspectCustomAgentsAndPresets(workspaceRoot);
    for (const agent of agents) {
      if (agent.model) {
        addModel(agent.model, agent.model, agent.filePath);
      }
    }

    // 4. Runtime environment variable
    if (process.env.COPILOT_MODEL) {
      addModel(
        process.env.COPILOT_MODEL,
        process.env.COPILOT_MODEL,
        "env:COPILOT_MODEL"
      );
    }

    return models;
  }

  async inspectEffortValues(workspaceRoot?: string): Promise<string[]> {
    const config = this.readEffectiveConfig(workspaceRoot);
    if (config) {
      if (Array.isArray(config.supported_effort_values)) {
        return config.supported_effort_values.map(String);
      }
      if (typeof config.reasoning_effort === "string") {
        return [config.reasoning_effort];
      }
      if (typeof config.reasoning === "string") {
        return [config.reasoning];
      }
    }

    if (process.env.COPILOT_REASONING_EFFORT) {
      return [process.env.COPILOT_REASONING_EFFORT];
    }

    return [];
  }

  async inspectReasoningOptions(workspaceRoot?: string): Promise<HostReasoningOptions> {
    const effortValues = await this.inspectEffortValues(workspaceRoot);
    return {
      native_field: "reasoning_effort",
      supported_values: effortValues,
      default_value: effortValues.length > 0 ? effortValues[0] : undefined,
    };
  }

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

  async inspectCompanionRegistration(
    workspaceRoot?: string,
    scope?: "project" | "global" | "user"
  ): Promise<CompanionRegistrationStatus> {
    const workspace = workspaceRoot || process.cwd();

    // 1. Repo-level MCP files
    const repoMcpFiles = [
      path.join(workspace, ".github", "copilot", "mcp.json"),
      path.join(workspace, ".copilot", "mcp.json"),
      path.join(workspace, ".github", "copilot", "config.json"),
      path.join(workspace, ".copilot", "config.json"),
    ];

    for (const targetFile of repoMcpFiles) {
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
              details: serverConfig,
            };
          }
        } catch {
          // Skip
        }
      }
    }

    // 2. User-level MCP files
    const userMcpFiles = [
      path.join(this.getGlobalCopilotDir(), "mcp.json"),
      path.join(os.homedir(), ".copilot", "mcp.json"),
      path.join(this.getGlobalCopilotDir(), "config.json"),
    ];

    for (const targetFile of userMcpFiles) {
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
              details: serverConfig,
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
          error: `GitHub Copilot CLI configuration file at '${targetFile}' contains syntax errors. Rejecting companion registration to prevent loss.`,
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
    const previewId = `preview-companion-copilot-${Date.now()}`;
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
        error:
          preview.error ||
          "Cannot apply companion registration for GitHub Copilot CLI.",
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
      message:
        "GitHub Copilot CLI companion registration applied successfully.",
    };
  }

  async validateCompanionRegistration(
    workspaceRoot?: string
  ): Promise<ValidationResult> {
    const status = await this.inspectCompanionRegistration(workspaceRoot);
    return {
      valid: status.registered,
      workspace: workspaceRoot,
      message: status.registered
        ? "GitHub Copilot CLI companion MCP server registration validated successfully."
        : "GitHub Copilot CLI companion MCP server is not registered.",
    };
  }

  async previewConfiguration(
    plan: ExecutionConfig,
    profile?: AgentProfile,
    workspaceRoot?: string
  ): Promise<RenderedConfiguration> {
    return this.renderConfiguration(plan, profile, workspaceRoot);
  }

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
          `Copilot configuration file at '${targetFile}' contains syntax errors. Rejecting mutation to prevent configuration loss.`
        );
      }
      initialText = existingContent;
    }

    const formatting = { formattingOptions: { insertSpaces: true, tabSize: 2 } };
    let currentText = initialText;

    // 1. Update model
    const modelEdits = jsonc.modify(currentText, ["model"], targetModel, formatting);
    currentText = jsonc.applyEdits(currentText, modelEdits);

    // 2. If effort / reasoning specified, update reasoning_effort
    if (targetEffort) {
      const effortEdits = jsonc.modify(
        currentText,
        ["reasoning_effort"],
        targetEffort,
        formatting
      );
      currentText = jsonc.applyEdits(currentText, effortEdits);
    }

    const files: RenderedFile[] = [
      {
        path: targetFile,
        content: currentText,
      },
    ];

    let combinedDiff = createUnifiedDiff(targetFile, existingContent, currentText);

    // 3. If decomposed work items present, render custom agent files with isolated worker context
    if (plan.work_items && plan.work_items.length > 0) {
      const agentsDir = path.join(workspace, ".github", "copilot", "agents");
      for (const item of plan.work_items) {
        const agentFilePath = path.join(agentsDir, `${item.ticket_id}.json`);
        let existingAgentContent: string | null = null;
        if (fs.existsSync(agentFilePath)) {
          existingAgentContent = await fsp.readFile(agentFilePath, "utf-8");
        }

        const agentObj: Record<string, any> = {
          name: item.ticket_id,
          description: `Isolated worker agent for ${item.ticket_id}`,
          model: item.model,
          context: "isolated-worker",
          isolated: true,
        };
        if (item.effort || item.effort_policy) {
          agentObj.reasoning_effort = item.effort || item.effort_policy;
        }

        const agentJsonText = JSON.stringify(agentObj, null, 2) + "\n";
        files.push({
          path: agentFilePath,
          content: agentJsonText,
        });

        combinedDiff +=
          "\n" +
          createUnifiedDiff(agentFilePath, existingAgentContent, agentJsonText);
      }
    }

    const previewId = `preview-copilot-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;

    return {
      preview_id: previewId,
      mutation_targets: files.map((f) => f.path),
      diff: combinedDiff,
      files,
    };
  }

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
      message: `GitHub Copilot CLI configuration applied successfully to ${appliedTargets.length} target(s).`,
    };
  }

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
        message: `GitHub Copilot CLI configuration file '${targetFile}' does not exist.`,
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
        message: `GitHub Copilot CLI configuration file '${targetFile}' is invalid: ${e.message}`,
        errors: [e.message],
      };
    }

    const expectedModel =
      expected.execution?.model || expected.controller?.model;
    const actualModel = parsed?.model;

    const errors: string[] = [];
    if (expectedModel && actualModel !== expectedModel) {
      errors.push(
        `Model mismatch: expected '${expectedModel}' but actual configuration has '${actualModel}'`
      );
    }

    // Validate work item custom agents
    if (expected.work_items) {
      for (const item of expected.work_items) {
        const agentPath = path.join(
          workspace,
          ".github",
          "copilot",
          "agents",
          `${item.ticket_id}.json`
        );
        if (!fs.existsSync(agentPath)) {
          errors.push(`Missing work item agent config: ${agentPath}`);
        } else {
          try {
            const agentContent = await fsp.readFile(agentPath, "utf-8");
            const agentParsed = jsonc.parse(agentContent);
            if (agentParsed?.model !== item.model) {
              errors.push(
                `Agent '${item.ticket_id}' model mismatch: expected '${item.model}', actual '${agentParsed?.model}'`
              );
            }
          } catch (e: any) {
            errors.push(`Failed to parse agent config at ${agentPath}: ${e.message}`);
          }
        }
      }
    }

    return {
      valid: errors.length === 0,
      workspace,
      message:
        errors.length === 0
          ? "GitHub Copilot CLI configuration validated successfully."
          : `Configuration validation failed with ${errors.length} error(s).`,
      errors: errors.length > 0 ? errors : undefined,
    };
  }

  async resolveReasoningPolicy(
    policy: string,
    _modelId?: string,
    workspaceRoot?: string
  ): Promise<ResolvedReasoningPolicy | undefined> {
    const options = await this.inspectReasoningOptions(workspaceRoot);
    const supported = options.supported_values;
    const normalized = policy.toLowerCase().trim();

    if (supported.length === 0) {
      return undefined;
    }

    let resolvedValue: string | undefined;
    if (normalized === "highest-supported") {
      resolvedValue = supported[supported.length - 1];
    } else if (normalized === "lowest-sufficient" || normalized === "lowest-supported") {
      resolvedValue = supported[0];
    } else if (normalized === "configured") {
      resolvedValue = options.default_value || supported[0];
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

  // --- Internal Helpers ---

  getGlobalCopilotDir(): string {
    return (
      process.env.COPILOT_CONFIG_DIR ||
      process.env.COPILOT_HOME ||
      path.join(
        process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
        "github-copilot"
      )
    );
  }

  determineTargetConfigPath(workspace: string): string {
    const githubCopilot = path.join(workspace, ".github", "copilot", "config.json");
    const copilotDir = path.join(workspace, ".copilot", "config.json");
    const copilotJson = path.join(workspace, "copilot.json");

    if (fs.existsSync(githubCopilot)) return githubCopilot;
    if (fs.existsSync(copilotDir)) return copilotDir;
    if (fs.existsSync(copilotJson)) return copilotJson;
    return githubCopilot;
  }

  determineMcpRegistrationPath(workspace: string): string {
    const githubCopilotMcp = path.join(workspace, ".github", "copilot", "mcp.json");
    const copilotMcp = path.join(workspace, ".copilot", "mcp.json");

    if (fs.existsSync(githubCopilotMcp)) return githubCopilotMcp;
    if (fs.existsSync(copilotMcp)) return copilotMcp;
    return githubCopilotMcp;
  }

  readEffectiveConfig(workspaceRoot?: string): Record<string, any> | null {
    let result: Record<string, any> = {};

    // 1. User config
    const userCandidates = [
      path.join(this.getGlobalCopilotDir(), "config.json"),
      path.join(os.homedir(), ".copilot", "config.json"),
    ];
    for (const p of userCandidates) {
      if (fs.existsSync(p)) {
        try {
          const parsed = jsonc.parse(fs.readFileSync(p, "utf-8"));
          if (parsed && typeof parsed === "object") {
            result = { ...result, ...parsed };
            break;
          }
        } catch {
          // Skip
        }
      }
    }

    // 2. Repo config (overrides user)
    if (workspaceRoot) {
      const repoCandidates = [
        path.join(workspaceRoot, ".github", "copilot", "config.json"),
        path.join(workspaceRoot, ".copilot", "config.json"),
        path.join(workspaceRoot, "copilot.json"),
        path.join(workspaceRoot, ".github", "copilot.json"),
      ];
      for (const p of repoCandidates) {
        if (fs.existsSync(p)) {
          try {
            const parsed = jsonc.parse(fs.readFileSync(p, "utf-8"));
            if (parsed && typeof parsed === "object") {
              result = { ...result, ...parsed };
              break;
            }
          } catch {
            // Skip
          }
        }
      }
    }

    return Object.keys(result).length > 0 ? result : null;
  }

  /**
   * Distinguishes custom agents with isolated worker execution contexts
   * from simple prompt presets (§34).
   */
  async inspectCustomAgentsAndPresets(workspaceRoot?: string): Promise<{
    agents: CopilotCustomAgent[];
    promptPresets: CopilotPromptPreset[];
  }> {
    const agents: CopilotCustomAgent[] = [];
    const promptPresets: CopilotPromptPreset[] = [];
    const seenNames = new Set<string>();

    const checkDir = (dirPath: string) => {
      if (!fs.existsSync(dirPath)) return;
      try {
        const files = fs.readdirSync(dirPath);
        for (const file of files) {
          if (file.endsWith(".json")) {
            const fullPath = path.join(dirPath, file);
            try {
              const content = fs.readFileSync(fullPath, "utf-8");
              const parsed = jsonc.parse(content);
              if (!parsed || typeof parsed !== "object") continue;

              const name = parsed.name || path.basename(file, ".json");
              if (seenNames.has(name)) continue;
              seenNames.add(name);

              // Distinguish: does this specify isolated worker context or agent capabilities?
              const isIsolated =
                parsed.isolated === true ||
                parsed.context === "isolated" ||
                parsed.context === "isolated-worker" ||
                parsed.sandbox === true ||
                Boolean(parsed.model) ||
                Boolean(parsed.tools) ||
                Boolean(parsed.mcpServers);

              if (isIsolated) {
                agents.push({
                  name,
                  model: parsed.model,
                  description: parsed.description,
                  context: parsed.context || "isolated-worker",
                  isolated: true,
                  tools: Array.isArray(parsed.tools) ? parsed.tools : undefined,
                  mcpServers: parsed.mcpServers,
                  filePath: fullPath,
                });
              } else if (parsed.prompt || parsed.template) {
                promptPresets.push({
                  name,
                  prompt: parsed.prompt || parsed.template,
                  description: parsed.description,
                  filePath: fullPath,
                });
              }
            } catch {
              // Skip
            }
          }
        }
      } catch {
        // Skip
      }
    };

    // 1. Repo agents
    if (workspaceRoot) {
      checkDir(path.join(workspaceRoot, ".github", "copilot", "agents"));
      checkDir(path.join(workspaceRoot, ".copilot", "agents"));

      // Check instructions / prompt presets file
      const presetFiles = [
        path.join(workspaceRoot, ".github", "copilot-instructions.md"),
        path.join(workspaceRoot, ".copilot", "instructions.md"),
        path.join(workspaceRoot, "copilot-instructions.md"),
      ];
      for (const pf of presetFiles) {
        if (fs.existsSync(pf)) {
          promptPresets.push({
            name: path.basename(pf),
            prompt: "system-instructions",
            description: "Repository copilot prompt preset",
            filePath: pf,
          });
        }
      }
    }

    // 2. Global user agents
    checkDir(path.join(this.getGlobalCopilotDir(), "agents"));
    checkDir(path.join(os.homedir(), ".copilot", "agents"));

    return { agents, promptPresets };
  }
}
