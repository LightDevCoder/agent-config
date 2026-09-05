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
  extractReasoningPolicy,
} from "../contract.js";
import { ExecutionConfig, AgentProfile } from "../../profile/schema.js";
import { createUnifiedDiff } from "../diff.js";

export interface ClaudeAgentInfo {
  name: string;
  model?: string;
  description?: string;
  filePath: string;
}

/**
 * Claude Code host adapter implementing authentic inspection, config hierarchy
 * (project vs user scope), subagents/custom agents in .claude/agents/*.md,
 * model inventory enumeration, honest reasoning reporting, and native MCP registration.
 */
export class ClaudeCodeAdapter implements HostAdapter {
  readonly id = "claude-code";
  readonly name = "Claude Code Adapter";

  hasActiveRuntimeContext(_workspaceRoot?: string): boolean {
    if (
      process.env.CLAUDE_CODE === "1" ||
      process.env.CLAUDE_CODE === "true" ||
      (process.env.CLAUDE_CODE_ENTRY && process.env.CLAUDE_CODE_ENTRY !== "undefined") ||
      (process.env.CLAUDE_PROJECT_DIR && process.env.CLAUDE_PROJECT_DIR !== "undefined") ||
      (process.env.CLAUDE_SESSION_ID && process.env.CLAUDE_SESSION_ID !== "undefined") ||
      (process.env.CLAUDE_CONFIG_DIR && process.env.CLAUDE_CONFIG_DIR !== "undefined") ||
      (process.env.CLAUDE_AUTO_COMPACT && process.env.CLAUDE_AUTO_COMPACT !== "undefined")
    ) {
      return true;
    }
    if (process.env._ && path.basename(process.env._).toLowerCase().includes("claude")) {
      return true;
    }
    if (process.title && path.basename(process.title).toLowerCase().includes("claude")) {
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
        path.join(workspaceRoot, ".claude"),
        path.join(workspaceRoot, ".claude.json"),
        path.join(workspaceRoot, ".claude", "settings.json"),
        path.join(workspaceRoot, ".claude", "config.json"),
        path.join(workspaceRoot, ".claude", "agents"),
      ];
      if (candidates.some((p) => fs.existsSync(p))) {
        return true;
      }
    }

    if (process.env.CLAUDE_CONFIG_DIR && fs.existsSync(process.env.CLAUDE_CONFIG_DIR)) {
      return true;
    }

    if (!workspaceRoot) {
      const globalCandidates = [
        path.join(os.homedir(), ".claude"),
        path.join(os.homedir(), ".claude.json"),
        path.join(os.homedir(), ".config", "claude"),
      ];
      return globalCandidates.some((p) => fs.existsSync(p));
    }

    return false;
  }

  async inspectVersion(workspaceRoot?: string): Promise<HostVersionInfo> {
    let version = process.env.CLAUDE_VERSION || process.env.CLAUDE_CODE_VERSION;
    let raw: string | undefined = version;

    if (!version && workspaceRoot) {
      const versionFile = path.join(workspaceRoot, ".claude", "version");
      if (fs.existsSync(versionFile)) {
        try {
          raw = fs.readFileSync(versionFile, "utf-8").trim();
          version = raw;
        } catch {
          // Skip read error
        }
      }
    }

    if (!version) {
      const globalVersionFile = path.join(this.getGlobalClaudeDir(), "version");
      if (fs.existsSync(globalVersionFile)) {
        try {
          raw = fs.readFileSync(globalVersionFile, "utf-8").trim();
          version = raw;
        } catch {
          // Skip read error
        }
      }
    }

    if (!version) {
      // Check version in ~/.claude.json or workspace .claude.json
      const jsonPaths = [
        workspaceRoot ? path.join(workspaceRoot, ".claude.json") : null,
        path.join(os.homedir(), ".claude.json"),
      ].filter((p): p is string => p !== null && fs.existsSync(p));

      for (const jsonPath of jsonPaths) {
        try {
          const content = fs.readFileSync(jsonPath, "utf-8");
          const parsed = jsonc.parse(content);
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

    if (normalized.startsWith("0.") || normalized.startsWith("1.") || normalized.startsWith("2.")) {
      return {
        version: normalized,
        compatibility: "supported",
        fail_closed_for_mutation: false,
        raw,
      };
    }

    if (normalized.startsWith("3.")) {
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
    const customAgents = await this.inspectCustomAgents(workspaceRoot);

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
          : undefined;
      if (parsedConcurrency !== undefined && parsedConcurrency > 0) {
        concurrencyLimit = parsedConcurrency;
        concurrencyState = "available";
      }
    }

    if (!concurrencyLimit && process.env.CLAUDE_MAX_CONCURRENCY) {
      const parsed = parseInt(process.env.CLAUDE_MAX_CONCURRENCY, 10);
      if (!isNaN(parsed) && parsed > 0) {
        concurrencyLimit = parsed;
        concurrencyState = "available";
      }
    }

    // Subagent capability: evidenced by .claude/agents directory, existing custom agents, or config
    const hasWorkspaceAgentsDir = workspaceRoot
      ? fs.existsSync(path.join(workspaceRoot, ".claude", "agents"))
      : false;
    const hasGlobalAgentsDir = fs.existsSync(path.join(this.getGlobalClaudeDir(), "agents"));
    const hasAgents =
      customAgents.length > 0 || hasWorkspaceAgentsDir || hasGlobalAgentsDir;

    const subagentsState: "available" | "unknown" = hasAgents ? "available" : "unknown";
    const subagentsEvidence = hasAgents
      ? {
          kind: "host-config" as const,
          locator: hasWorkspaceAgentsDir
            ? ".claude/agents"
            : hasGlobalAgentsDir
            ? "~/.claude/agents"
            : "claude-code customAgents",
        }
      : undefined;

    const perAgentModelSelectionState: "available" | "unknown" =
      subagentsState === "available" ? "available" : "unknown";

    const reasoningState: "available" | "unknown" =
      effortValues.length > 0 ? "available" : "unknown";

    const targetConfigPath = this.determineTargetConfigPath(workspaceRoot || process.cwd());

    return {
      host_id: "claude-code",
      adapter_id: "claude-code",
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
            locator: ".claude session store",
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
                  locator: ".claude/agents/*.md",
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

    // 1. Check workspace config
    if (workspaceRoot) {
      const projectConfigPaths = [
        path.join(workspaceRoot, ".claude", "settings.json"),
        path.join(workspaceRoot, ".claude.json"),
        path.join(workspaceRoot, ".claude", "config.json"),
      ];
      for (const p of projectConfigPaths) {
        if (fs.existsSync(p)) {
          try {
            const parsed = jsonc.parse(fs.readFileSync(p, "utf-8"));
            if (parsed && typeof parsed.model === "string") {
              addModel(parsed.model, parsed.model, p);
            }
            if (parsed && Array.isArray(parsed.models)) {
              for (const m of parsed.models) {
                if (typeof m === "string") addModel(m, m, p);
                else if (m && typeof m.id === "string")
                  addModel(m.id, m.name || m.id, p);
              }
            }
          } catch {
            // Skip
          }
        }
      }
    }

    // 2. Check user config
    const userConfigPaths = [
      path.join(this.getGlobalClaudeDir(), "settings.json"),
      path.join(os.homedir(), ".claude.json"),
      path.join(this.getGlobalClaudeDir(), "config.json"),
    ];
    for (const p of userConfigPaths) {
      if (fs.existsSync(p)) {
        try {
          const parsed = jsonc.parse(fs.readFileSync(p, "utf-8"));
          if (parsed && typeof parsed.model === "string") {
            addModel(parsed.model, parsed.model, p);
          }
          if (parsed && Array.isArray(parsed.models)) {
            for (const m of parsed.models) {
              if (typeof m === "string") addModel(m, m, p);
              else if (m && typeof m.id === "string")
                addModel(m.id, m.name || m.id, p);
            }
          }
        } catch {
          // Skip
        }
      }
    }

    // 3. Check custom agents in .claude/agents/*.md
    const agents = await this.inspectCustomAgents(workspaceRoot);
    for (const agent of agents) {
      if (agent.model) {
        addModel(agent.model, agent.model, agent.filePath);
      }
    }

    // 4. Runtime environment variable
    if (process.env.CLAUDE_MODEL) {
      addModel(process.env.CLAUDE_MODEL, process.env.CLAUDE_MODEL, "env:CLAUDE_MODEL");
    }

    return models;
  }

  async inspectEffortValues(workspaceRoot?: string): Promise<string[]> {
    const config = this.readEffectiveConfig(workspaceRoot);
    const values = new Set<string>();

    if (config) {
      if (typeof config.effortLevel === "string" && config.effortLevel.trim()) {
        values.add(config.effortLevel.trim());
      }
      if (typeof config.effort === "string" && config.effort.trim()) {
        values.add(config.effort.trim());
      }
      if (config.settings && typeof config.settings === "object") {
        if (typeof config.settings.effortLevel === "string" && config.settings.effortLevel.trim()) {
          values.add(config.settings.effortLevel.trim());
        }
        if (typeof config.settings.effort === "string" && config.settings.effort.trim()) {
          values.add(config.settings.effort.trim());
        }
      }
      if (Array.isArray(config.supported_effort_values)) {
        config.supported_effort_values.forEach((v: any) => values.add(String(v)));
      }
      if (typeof config.reasoning_effort === "string") {
        values.add(config.reasoning_effort.trim());
      }
      if (config.thinking && typeof config.thinking === "object") {
        if (Array.isArray(config.thinking.supported_values)) {
          config.thinking.supported_values.forEach((v: any) => values.add(String(v)));
        } else if (config.thinking.type === "enabled" || config.thinking.budget_tokens) {
          values.add("enabled");
          values.add("disabled");
        }
      }
    }

    if (process.env.CLAUDE_EFFORT_LEVEL) {
      values.add(process.env.CLAUDE_EFFORT_LEVEL.trim());
    }
    if (process.env.CLAUDE_EFFORT) {
      values.add(process.env.CLAUDE_EFFORT.trim());
    }
    if (process.env.CLAUDE_REASONING_EFFORT) {
      values.add(process.env.CLAUDE_REASONING_EFFORT.trim());
    }
    if (process.env.CLAUDE_THINKING) {
      values.add("enabled");
      values.add("disabled");
    }

    if (process.env.CLAUDE_ARGS) {
      const match = process.env.CLAUDE_ARGS.match(/--effort[=\s]+([^\s]+)/);
      if (match) {
        values.add(match[1].trim());
      }
    }

    return Array.from(values);
  }

  async inspectReasoningOptions(workspaceRoot?: string): Promise<HostReasoningOptions> {
    const effortValues = await this.inspectEffortValues(workspaceRoot);
    const config = this.readEffectiveConfig(workspaceRoot);

    let nativeField = "thinking";
    if (
      config?.effortLevel ||
      config?.effort ||
      config?.settings?.effortLevel ||
      config?.settings?.effort ||
      process.env.CLAUDE_EFFORT_LEVEL ||
      process.env.CLAUDE_EFFORT ||
      process.env.CLAUDE_ARGS?.includes("--effort")
    ) {
      nativeField = "effortLevel";
    }

    return {
      native_field: nativeField,
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

    // Check project-level MCP surface: strictly .mcp.json in workspace root
    if (scope !== "global" && scope !== "user" && workspaceRoot) {
      const targetFile = path.join(workspace, ".mcp.json");
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

    // Check user/global MCP surface: strictly ~/.claude.json
    if (scope !== "project") {
      const targetFile = path.join(os.homedir(), ".claude.json");
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

    const defaultTarget = this.determineMcpRegistrationPath(workspace, scope);
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
    const resolvedScope: "project" | "global" =
      scope === "global" || scope === "user" || (!scope && !workspaceRoot)
        ? "global"
        : "project";
    const targetFile = this.determineMcpRegistrationPath(workspace, scope);

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
          error: `Claude Code configuration file at '${targetFile}' contains syntax errors. Rejecting companion registration to prevent loss.`,
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
    const previewId = `preview-companion-claude-${Date.now()}`;
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
    workspaceRoot?: string,
    providedPreview?: CompanionRegistrationPreview
  ): Promise<ApplyResult> {
    const preview = providedPreview || (await this.previewCompanionRegistration(workspaceRoot));
    if (!preview.supported || !preview.files || preview.files.length === 0) {
      return {
        success: false,
        preview_id: previewHash,
        applied_targets: [],
        error: preview.error || "Cannot apply companion registration for Claude Code.",
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
      message: "Claude Code companion registration applied successfully.",
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
        ? "Claude Code companion MCP server registration validated successfully."
        : "Claude Code companion MCP server is not registered.",
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
      extractReasoningPolicy(plan.execution) ||
      extractReasoningPolicy(plan.controller) ||
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
          `Claude Code configuration file at '${targetFile}' contains syntax errors. Rejecting mutation to prevent configuration loss.`
        );
      }
      initialText = existingContent;
    }

    const formatting = { formattingOptions: { insertSpaces: true, tabSize: 2 } };
    let currentText = initialText;

    // 1. Update model
    const modelEdits = jsonc.modify(currentText, ["model"], targetModel, formatting);
    currentText = jsonc.applyEdits(currentText, modelEdits);

    // 2. If effort / thinking specified, update thinking
    if (targetEffort) {
      const thinkingEdits = jsonc.modify(
        currentText,
        ["thinking"],
        { type: "enabled", budget_tokens: 4096 },
        formatting
      );
      currentText = jsonc.applyEdits(currentText, thinkingEdits);
    }

    const files: RenderedFile[] = [
      {
        path: targetFile,
        content: currentText,
      },
    ];

    let combinedDiff = createUnifiedDiff(targetFile, existingContent, currentText);

    // 3. If decomposed work items present, render agent markdown files in .claude/agents/
    if (plan.work_items && plan.work_items.length > 0) {
      const agentsDir = path.join(workspace, ".claude", "agents");
      for (const item of plan.work_items) {
        const agentFilePath = path.join(agentsDir, `${item.ticket_id}.md`);
        let existingAgentContent: string | null = null;
        if (fs.existsSync(agentFilePath)) {
          existingAgentContent = await fsp.readFile(agentFilePath, "utf-8");
        }

        const agentFrontmatter = [
          "---",
          `name: "${item.ticket_id}"`,
          `model: "${item.model}"`,
          `description: "Worker agent for ${item.ticket_id}"`,
          "---",
          "",
          `You are an isolated worker agent assigned to ticket ${item.ticket_id}.`,
          "",
        ].join("\n");

        files.push({
          path: agentFilePath,
          content: agentFrontmatter,
        });

        combinedDiff +=
          "\n" +
          createUnifiedDiff(agentFilePath, existingAgentContent, agentFrontmatter);
      }
    }

    const previewId = `preview-claude-${Date.now()}-${Math.random()
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
      message: `Claude Code configuration applied successfully to ${appliedTargets.length} target(s).`,
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
        message: `Claude Code configuration file '${targetFile}' does not exist.`,
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
        message: `Claude Code configuration file '${targetFile}' is invalid: ${e.message}`,
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

    // Validate work items
    if (expected.work_items) {
      for (const item of expected.work_items) {
        const agentPath = path.join(
          workspace,
          ".claude",
          "agents",
          `${item.ticket_id}.md`
        );
        if (!fs.existsSync(agentPath)) {
          errors.push(`Missing work item agent config: ${agentPath}`);
        } else {
          const agentContent = await fsp.readFile(agentPath, "utf-8");
          const modelMatch = agentContent.match(/model:\s*"([^"]+)"/);
          const actualAgentModel = modelMatch ? modelMatch[1] : undefined;
          if (actualAgentModel !== item.model) {
            errors.push(
              `Agent '${item.ticket_id}' model mismatch: expected '${item.model}', actual '${actualAgentModel}'`
            );
          }
        }
      }
    }

    return {
      valid: errors.length === 0,
      workspace,
      message:
        errors.length === 0
          ? "Claude Code configuration validated successfully."
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
      host_field: options.native_field,
      host_value: resolvedValue,
    };
  }

  // --- Internal Helpers ---

  getGlobalClaudeDir(): string {
    return (
      process.env.CLAUDE_CONFIG_DIR ||
      path.join(os.homedir(), ".claude")
    );
  }

  determineTargetConfigPath(workspace: string): string {
    const settingsPath = path.join(workspace, ".claude", "settings.json");
    const jsonPath = path.join(workspace, ".claude.json");
    if (fs.existsSync(settingsPath)) return settingsPath;
    if (fs.existsSync(jsonPath)) return jsonPath;
    return settingsPath;
  }

  determineMcpRegistrationPath(workspace: string, scope?: "project" | "global" | "user"): string {
    if (scope === "global" || scope === "user" || !workspace) {
      return path.join(os.homedir(), ".claude.json");
    }
    return path.join(workspace, ".mcp.json");
  }

  readEffectiveConfig(workspaceRoot?: string): Record<string, any> | null {
    let result: Record<string, any> = {};

    // 1. Read global user config first
    const userCandidates = [
      path.join(this.getGlobalClaudeDir(), "settings.json"),
      path.join(os.homedir(), ".claude.json"),
      path.join(this.getGlobalClaudeDir(), "config.json"),
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

    // 2. Read workspace config (overrides user)
    if (workspaceRoot) {
      const projectCandidates = [
        path.join(workspaceRoot, ".claude", "settings.json"),
        path.join(workspaceRoot, ".claude.json"),
        path.join(workspaceRoot, ".claude", "config.json"),
      ];
      for (const p of projectCandidates) {
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

  async inspectCustomAgents(workspaceRoot?: string): Promise<ClaudeAgentInfo[]> {
    const agents: ClaudeAgentInfo[] = [];
    const seenNames = new Set<string>();

    const checkDir = (dirPath: string) => {
      if (!fs.existsSync(dirPath)) return;
      try {
        const files = fs.readdirSync(dirPath);
        for (const file of files) {
          if (file.endsWith(".md")) {
            const fullPath = path.join(dirPath, file);
            try {
              const content = fs.readFileSync(fullPath, "utf-8");
              const parsed = this.parseAgentMarkdown(content, file);
              if (parsed && !seenNames.has(parsed.name)) {
                seenNames.add(parsed.name);
                agents.push({
                  ...parsed,
                  filePath: fullPath,
                });
              }
            } catch {
              // Skip
            }
          } else if (file.endsWith(".json")) {
            const fullPath = path.join(dirPath, file);
            try {
              const content = fs.readFileSync(fullPath, "utf-8");
              const parsed = jsonc.parse(content);
              const name = parsed?.name || path.basename(file, ".json");
              if (parsed && !seenNames.has(name)) {
                seenNames.add(name);
                agents.push({
                  name,
                  model: parsed.model,
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

    // Project agents
    if (workspaceRoot) {
      checkDir(path.join(workspaceRoot, ".claude", "agents"));
    }

    // Global agents
    checkDir(path.join(this.getGlobalClaudeDir(), "agents"));

    return agents;
  }

  parseAgentMarkdown(
    content: string,
    filename: string
  ): { name: string; model?: string; description?: string } | null {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const fallbackName = path.basename(filename, ".md");
    if (!match) {
      return { name: fallbackName };
    }

    const frontmatterText = match[1];
    let name = fallbackName;
    let model: string | undefined;
    let description: string | undefined;

    for (const line of frontmatterText.split(/\r?\n/)) {
      const colonIdx = line.indexOf(":");
      if (colonIdx > 0) {
        const key = line.slice(0, colonIdx).trim();
        const val = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, "");
        if (key === "name" && val) name = val;
        else if (key === "model" && val) model = val;
        else if (key === "description" && val) description = val;
      }
    }

    return { name, model, description };
  }
}
