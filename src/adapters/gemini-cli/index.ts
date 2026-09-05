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
  extractReasoningPolicy,
} from "../contract.js";
import { ExecutionConfig, AgentProfile } from "../../profile/schema.js";
import { createUnifiedDiff } from "../diff.js";

/**
 * Gemini CLI native adapter supporting authentic host detection, project vs user
 * configuration hierarchy, evidenced model discovery, explicit marking of subagents
 * and per-worker model controls as unavailable, headless detection, and native MCP configuration.
 */
export class GeminiCliAdapter implements HostAdapter {
  readonly id = "gemini-cli";
  readonly name = "Antigravity / Gemini CLI Adapter";
  readonly aliases = ["antigravity"];

  hasActiveRuntimeContext(_workspaceRoot?: string): boolean {
    if (
      process.env.GEMINI_CLI === "1" ||
      process.env.GEMINI_CLI === "true" ||
      process.env.ANTIGRAVITY === "1" ||
      process.env.ANTIGRAVITY === "true" ||
      process.env.AGY === "1" ||
      process.env.AGY === "true" ||
      (process.env.GEMINI_PROJECT_DIR && process.env.GEMINI_PROJECT_DIR !== "undefined") ||
      (process.env.GEMINI_SESSION_ID && process.env.GEMINI_SESSION_ID !== "undefined") ||
      (process.env.GEMINI_CONFIG_DIR && process.env.GEMINI_CONFIG_DIR !== "undefined") ||
      (process.env.GEMINI_HOME && process.env.GEMINI_HOME !== "undefined") ||
      (process.env.ANTIGRAVITY_HOME && process.env.ANTIGRAVITY_HOME !== "undefined")
    ) {
      return true;
    }

    if (
      process.env._ &&
      (path.basename(process.env._).toLowerCase().includes("gemini") ||
        path.basename(process.env._).toLowerCase().includes("antigravity") ||
        path.basename(process.env._).toLowerCase() === "agy")
    ) {
      return true;
    }
    if (
      process.title &&
      (path.basename(process.title).toLowerCase().includes("gemini") ||
        path.basename(process.title).toLowerCase().includes("antigravity") ||
        path.basename(process.title).toLowerCase() === "agy")
    ) {
      return true;
    }
    return false;
  }

  isHeadlessExecution(_workspaceRoot?: string): boolean {
    if (
      process.env.GEMINI_HEADLESS === "1" ||
      process.env.GEMINI_HEADLESS === "true" ||
      process.env.GEMINI_NON_INTERACTIVE === "1" ||
      process.env.GEMINI_NON_INTERACTIVE === "true" ||
      process.env.CI === "1" ||
      process.env.CI === "true"
    ) {
      return true;
    }
    if (process.stdin && process.stdin.isTTY === false) {
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
        path.join(workspaceRoot, ".agents", "mcp_config.json"),
        path.join(workspaceRoot, ".gemini"),
        path.join(workspaceRoot, ".gemini", "config.json"),
        path.join(workspaceRoot, ".gemini", "settings.json"),
        path.join(workspaceRoot, ".gemini", "antigravity-cli", "settings.json"),
        path.join(workspaceRoot, "gemini.json"),
        path.join(workspaceRoot, ".gemini", "mcp.json"),
      ];
      if (candidates.some((p) => fs.existsSync(p))) {
        return true;
      }
    }

    if (process.env.GEMINI_CONFIG_DIR && fs.existsSync(process.env.GEMINI_CONFIG_DIR)) {
      return true;
    }

    if (!workspaceRoot) {
      const globalCandidates = [
        path.join(os.homedir(), ".gemini", "antigravity-cli", "settings.json"),
        path.join(os.homedir(), ".gemini", "antigravity-cli"),
        path.join(os.homedir(), ".gemini", "config", "mcp_config.json"),
        path.join(os.homedir(), ".gemini", "mcp_config.json"),
        path.join(this.getGlobalGeminiDir(), "antigravity-cli", "settings.json"),
        this.getGlobalGeminiDir(),
        path.join(os.homedir(), ".gemini"),
        path.join(os.homedir(), ".gemini", "config"),
        path.join(os.homedir(), ".gemini", "antigravity"),
        path.join(os.homedir(), ".gemini", "config.json"),
        path.join(os.homedir(), ".gemini", "settings.json"),
        path.join(os.homedir(), ".config", "gemini"),
        path.join(os.homedir(), ".config", "gemini", "config.json"),
        path.join(os.homedir(), "gemini.json"),
      ];
      return globalCandidates.some((p) => fs.existsSync(p));
    }

    return false;
  }

  async inspectVersion(workspaceRoot?: string): Promise<HostVersionInfo> {
    let version =
      process.env.AGY_VERSION ||
      process.env.ANTIGRAVITY_VERSION ||
      process.env.GEMINI_CLI_VERSION ||
      process.env.GEMINI_VERSION;
    let raw: string | undefined = version;

    if (!version && workspaceRoot) {
      const versionCandidates = [
        path.join(workspaceRoot, ".gemini", "version"),
        path.join(workspaceRoot, ".agents", "version"),
      ];
      for (const versionFile of versionCandidates) {
        if (fs.existsSync(versionFile)) {
          try {
            raw = fs.readFileSync(versionFile, "utf-8").trim();
            version = raw;
            break;
          } catch {
            // Skip read error
          }
        }
      }
    }

    if (!version) {
      const globalVersionFiles = [
        path.join(os.homedir(), ".gemini", "antigravity-cli", "version"),
        path.join(this.getGlobalGeminiDir(), "version"),
      ];
      for (const globalVersionFile of globalVersionFiles) {
        if (fs.existsSync(globalVersionFile)) {
          try {
            raw = fs.readFileSync(globalVersionFile, "utf-8").trim();
            version = raw;
            break;
          } catch {
            // Skip read error
          }
        }
      }
    }

    if (!version) {
      // 1. Check canonical agy binary first
      let cliResult = await this.runCliCommand("agy", ["--version"], workspaceRoot);
      if (!cliResult) {
        cliResult = await this.runCliCommand("gemini", ["--version"], workspaceRoot);
      }
      if (!cliResult) {
        cliResult = await this.runCliCommand("antigravity", ["--version"], workspaceRoot);
      }
      if (cliResult && cliResult.stdout.trim().length > 0) {
        raw = cliResult.stdout.trim().split(/\r?\n/)[0];
        const match = raw.match(/\d+\.\d+(\.\d+)?/);
        if (match) {
          version = match[0];
        } else {
          version = raw;
        }
      }
    }

    if (!version) {
      return {
        compatibility: "unknown-version",
        fail_closed_for_mutation: true,
      };
    }

    if (version.toLowerCase().includes("incompatible")) {
      return {
        version,
        raw,
        compatibility: "incompatible",
        fail_closed_for_mutation: true,
      };
    }

    return {
      version,
      raw,
      compatibility: "supported",
      fail_closed_for_mutation: false,
    };
  }

  readEffectiveConfig(workspaceRoot?: string): {
    config: Record<string, any>;
    sourcePath?: string;
    isProject: boolean;
  } | null {
    const workspace = workspaceRoot || process.cwd();

    // 1. Project-level configs (highest precedence)
    const projectCandidates = [
      path.join(workspace, ".gemini", "antigravity-cli", "settings.json"),
      path.join(workspace, ".gemini", "settings.json"),
      path.join(workspace, ".gemini", "config.json"),
      path.join(workspace, "gemini.json"),
    ];

    for (const p of projectCandidates) {
      if (fs.existsSync(p)) {
        try {
          const content = fs.readFileSync(p, "utf-8");
          const parsed = jsonc.parse(content);
          if (parsed && typeof parsed === "object") {
            return { config: parsed, sourcePath: p, isProject: true };
          }
        } catch {
          // Skip parse error
        }
      }
    }

    // 2. User-level configs
    const userCandidates = [
      path.join(os.homedir(), ".gemini", "antigravity-cli", "settings.json"),
      path.join(this.getGlobalGeminiDir(), "antigravity-cli", "settings.json"),
      path.join(this.getGlobalGeminiDir(), "settings.json"),
      path.join(this.getGlobalGeminiDir(), "config.json"),
      path.join(os.homedir(), ".gemini", "settings.json"),
      path.join(os.homedir(), ".gemini", "config", "config.json"),
      path.join(os.homedir(), ".gemini", "config.json"),
      path.join(os.homedir(), ".config", "gemini", "config.json"),
      path.join(os.homedir(), "gemini.json"),
    ];

    for (const p of userCandidates) {
      if (fs.existsSync(p)) {
        try {
          const content = fs.readFileSync(p, "utf-8");
          const parsed = jsonc.parse(content);
          if (parsed && typeof parsed === "object") {
            return { config: parsed, sourcePath: p, isProject: false };
          }
        } catch {
          // Skip parse error
        }
      }
    }

    return null;
  }

  async inspectModels(workspaceRoot?: string): Promise<HostModel[]> {
    const models: HostModel[] = [];
    const seen = new Set<string>();

    const effective = this.readEffectiveConfig(workspaceRoot);
    if (effective) {
      const cfg = effective.config;
      const locator = effective.sourcePath || "gemini-config";

      if (typeof cfg.model === "string" && cfg.model.trim().length > 0) {
        const id = cfg.model.trim();
        if (!seen.has(id)) {
          seen.add(id);
          models.push({
            id,
            label: id,
            state: "available",
            features: ["gemini-api"],
            evidence: { kind: "host-config", locator },
          });
        }
      }

      if (typeof cfg.fallback_model === "string" && cfg.fallback_model.trim().length > 0) {
        const id = cfg.fallback_model.trim();
        if (!seen.has(id)) {
          seen.add(id);
          models.push({
            id,
            label: id,
            state: "available",
            features: ["gemini-api", "fallback"],
            evidence: { kind: "host-config", locator },
          });
        }
      }

      if (Array.isArray(cfg.available_models)) {
        for (const m of cfg.available_models) {
          if (typeof m === "string" && m.trim().length > 0) {
            const id = m.trim();
            if (!seen.has(id)) {
              seen.add(id);
              models.push({
                id,
                label: id,
                state: "available",
                features: ["gemini-api"],
                evidence: { kind: "host-config", locator },
              });
            }
          }
        }
      }

      if (Array.isArray(cfg.models)) {
        for (const m of cfg.models) {
          if (typeof m === "string" && m.trim().length > 0) {
            const id = m.trim();
            if (!seen.has(id)) {
              seen.add(id);
              models.push({
                id,
                label: id,
                state: "available",
                features: ["gemini-api"],
                evidence: { kind: "host-config", locator },
              });
            }
          }
        }
      }
    }

    if (process.env.GEMINI_MODEL && process.env.GEMINI_MODEL.trim().length > 0) {
      const id = process.env.GEMINI_MODEL.trim();
      if (!seen.has(id)) {
        seen.add(id);
        models.push({
          id,
          label: id,
          state: "available",
          features: ["gemini-api"],
          evidence: { kind: "host-runtime", locator: "env:GEMINI_MODEL" },
        });
      }
    }

    return models;
  }

  async inspectEffortValues(workspaceRoot?: string): Promise<string[]> {
    const options = await this.inspectReasoningOptions(workspaceRoot);
    return options.supported_values;
  }

  async inspectReasoningOptions(workspaceRoot?: string): Promise<HostReasoningOptions> {
    const effective = this.readEffectiveConfig(workspaceRoot);
    let reasoningVal = process.env.GEMINI_REASONING_EFFORT;

    if (!reasoningVal && effective) {
      reasoningVal =
        effective.config.reasoning_effort ||
        effective.config.thinking_budget ||
        (effective.config.thinking && effective.config.thinking.effort);
    }

    if (reasoningVal) {
      const valStr = String(reasoningVal);
      return {
        native_field: "reasoning_effort",
        supported_values: [valStr],
        default_value: valStr,
      };
    }

    return {
      native_field: "reasoning_effort",
      supported_values: [],
    };
  }

  async inspectExecutionTopologyCapabilities(
    workspaceRoot?: string
  ): Promise<TopologyCapabilities> {
    const caps = await this.inspectCapabilities(workspaceRoot);
    const subagentsAvailable = caps.capabilities.subagents.state === "available";
    const parallelismAvailable = caps.capabilities.parallelism.state === "available";
    return {
      supports_single_session: true,
      supports_subagents: subagentsAvailable,
      supports_multi_agent: parallelismAvailable,
      supports_parallel_execution: parallelismAvailable,
      max_concurrency: caps.capabilities.concurrency?.max_concurrency || 1,
    };
  }

  async inspectCapabilities(workspaceRoot?: string): Promise<HostCapabilities> {
    const models = await this.inspectModels(workspaceRoot);
    const reasoningOpts = await this.inspectReasoningOptions(workspaceRoot);

    const hasReasoning = reasoningOpts.supported_values.length > 0;
    const hasModels = models.length > 0;

    const effective = this.readEffectiveConfig(workspaceRoot);
    const cfg = effective?.config || {};

    const subagentsEvidence =
      process.env.ANTIGRAVITY_SUBAGENTS === "1" ||
      process.env.ANTIGRAVITY_SUBAGENTS === "true" ||
      process.env.AGY_SUBAGENTS === "1" ||
      process.env.AGY_SUBAGENTS === "true" ||
      process.env.GEMINI_SUBAGENTS === "1" ||
      process.env.GEMINI_SUBAGENTS === "true" ||
      cfg.subagents === true ||
      cfg.subagents?.enabled === true ||
      cfg.features?.subagents === true;

    const teamworkEvidence =
      process.env.ANTIGRAVITY_TEAMWORK === "1" ||
      process.env.ANTIGRAVITY_TEAMWORK === "true" ||
      process.env.ANTIGRAVITY_COLLABORATION === "1" ||
      process.env.ANTIGRAVITY_COLLABORATION === "true" ||
      process.env.AGY_TEAMWORK === "1" ||
      process.env.AGY_TEAMWORK === "true" ||
      process.env.GEMINI_TEAMWORK === "1" ||
      process.env.GEMINI_TEAMWORK === "true" ||
      cfg.teamwork === true ||
      cfg.teamwork?.enabled === true ||
      cfg.collaboration === true ||
      cfg.collaboration?.enabled === true ||
      cfg.features?.teamwork === true ||
      cfg.features?.collaboration === true;

    const subagentsState = subagentsEvidence ? "available" : "unavailable";
    const subagentsLocator = subagentsEvidence
      ? effective?.sourcePath || "antigravity:subagents"
      : "gemini-cli-architecture";
    const subagentsEvidenceKind = subagentsEvidence
      ? effective?.sourcePath
        ? ("host-config" as const)
        : ("host-runtime" as const)
      : ("host-runtime" as const);

    const perAgentModelSelectionState =
      subagentsEvidence &&
      (cfg.per_agent_model_selection === true || cfg.subagents?.per_agent_models === true)
        ? "available"
        : "unavailable";

    const maxConcurrency =
      typeof cfg.max_concurrency === "number"
        ? cfg.max_concurrency
        : typeof cfg.concurrency === "number"
        ? cfg.concurrency
        : teamworkEvidence
        ? 4
        : 1;

    return {
      host_id: this.id,
      adapter_id: this.id,
      workspace: workspaceRoot,
      observed_at: new Date().toISOString(),
      platform: process.platform,
      available_models: models,
      supported_effort_values: reasoningOpts.supported_values,
      default_effort_value: reasoningOpts.default_value,
      capabilities: {
        subagents: {
          state: subagentsState,
          evidence: { kind: subagentsEvidenceKind, locator: subagentsLocator },
        },
        per_agent_model_selection: {
          state: perAgentModelSelectionState,
          evidence: { kind: subagentsEvidenceKind, locator: subagentsLocator },
        },
        threads: {
          state: teamworkEvidence ? "available" : "unavailable",
        },
        parallelism: {
          state: teamworkEvidence ? "available" : "unavailable",
        },
        concurrency: {
          state: teamworkEvidence ? "available" : "unavailable",
          max_concurrency: maxConcurrency,
        },
        model_selection: {
          state: hasModels ? "available" : "unknown",
          scopes: hasModels ? ["current-session", "new-session"] : undefined,
        },
        reasoning: {
          state: hasReasoning ? "available" : "unavailable",
        },
        configuration_mutation: {
          state: "available",
          supports_native_files: true,
          supports_session_mutation: false,
        },
      },
    };
  }

  async inspectCompanionRegistration(
    workspaceRoot?: string,
    scope?: "project" | "global" | "user"
  ): Promise<CompanionRegistrationStatus> {
    const workspace = workspaceRoot || process.cwd();

    const candidateFiles = [
      path.join(workspace, ".agents", "mcp_config.json"),
      path.join(workspace, ".gemini", "mcp_config.json"),
      path.join(workspace, ".gemini", "config.json"),
      path.join(workspace, ".gemini", "settings.json"),
      path.join(workspace, ".gemini", "antigravity-cli", "settings.json"),
      path.join(workspace, "gemini.json"),
      path.join(workspace, ".gemini", "mcp.json"),
      path.join(os.homedir(), ".gemini", "config", "mcp_config.json"),
      path.join(os.homedir(), ".gemini", "mcp_config.json"),
      path.join(os.homedir(), ".gemini", "antigravity-cli", "settings.json"),
      path.join(this.getGlobalGeminiDir(), "config", "mcp_config.json"),
      path.join(this.getGlobalGeminiDir(), "mcp_config.json"),
      path.join(this.getGlobalGeminiDir(), "config.json"),
      path.join(os.homedir(), ".gemini", "config", "config.json"),
      path.join(os.homedir(), ".gemini", "config.json"),
      path.join(os.homedir(), ".config", "gemini", "config.json"),
    ];

    for (const f of candidateFiles) {
      if (fs.existsSync(f)) {
        try {
          const content = fs.readFileSync(f, "utf-8");
          const parsed = jsonc.parse(content);
          const serverConfig =
            parsed?.mcp?.servers?.["agent-config"] ||
            parsed?.mcpServers?.["agent-config"];

          if (serverConfig) {
            const isWorkspace = workspaceRoot ? f.startsWith(workspace) : false;
            return {
              registered: true,
              transport: "stdio",
              scope: isWorkspace ? "project" : "global",
              locator: f,
              command: serverConfig.command,
              args: serverConfig.args,
              target_file: f,
              details: serverConfig,
            };
          }
        } catch {
          // Skip parse error
        }
      }
    }

    const resolvedScope: "project" | "global" =
      scope === "global" || scope === "user" || (!scope && !workspaceRoot)
        ? "global"
        : "project";
    const defaultTarget = this.determineMcpRegistrationPath(workspace, resolvedScope);
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
    const targetFile = this.determineMcpRegistrationPath(workspace, resolvedScope);

    let existingContent: string | null = null;
    let initialText = targetFile.endsWith("mcp_config.json")
      ? "{\n  \"mcpServers\": {}\n}\n"
      : "{\n  \"mcp\": {\n    \"servers\": {}\n  }\n}\n";

    if (fs.existsSync(targetFile)) {
      existingContent = await fsp.readFile(targetFile, "utf-8");
      const parseErrors: jsonc.ParseError[] = [];
      const parsed = jsonc.parse(existingContent, parseErrors, { allowTrailingComma: true });
      if (parseErrors.length > 0) {
        return {
          supported: false,
          adapter_id: this.id,
          host_id: this.id,
          scope: resolvedScope,
          target_file: targetFile,
          mutation_targets: [],
          error: `Gemini CLI configuration file at '${targetFile}' contains syntax errors. Rejecting companion registration to prevent data loss.`,
        };
      }
      initialText = existingContent;

      const formatting = { formattingOptions: { insertSpaces: true, tabSize: 2 } };
      let edits: jsonc.Edit[];
      if (
        (parsed && typeof parsed === "object" && parsed.mcpServers !== undefined) ||
        targetFile.endsWith("mcp_config.json")
      ) {
        edits = jsonc.modify(
          initialText,
          ["mcpServers", "agent-config"],
          { command: "agent-config", args: ["serve"] },
          formatting
        );
      } else {
        edits = jsonc.modify(
          initialText,
          ["mcp", "servers", "agent-config"],
          { command: "agent-config", args: ["serve"] },
          formatting
        );
      }
      const newContent = jsonc.applyEdits(initialText, edits);
      const diff = createUnifiedDiff(targetFile, existingContent, newContent);
      const previewId = `preview-companion-gemini-${Date.now()}`;
      const previewHash = crypto.createHash("sha256").update(newContent).digest("hex");
      const baselineHash = crypto.createHash("sha256").update(existingContent).digest("hex");

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

    const formatting = { formattingOptions: { insertSpaces: true, tabSize: 2 } };
    const edits = targetFile.endsWith("mcp_config.json")
      ? jsonc.modify(
          initialText,
          ["mcpServers", "agent-config"],
          { command: "agent-config", args: ["serve"] },
          formatting
        )
      : jsonc.modify(
          initialText,
          ["mcp", "servers", "agent-config"],
          { command: "agent-config", args: ["serve"] },
          formatting
        );
    const newContent = jsonc.applyEdits(initialText, edits);
    const diff = createUnifiedDiff(targetFile, existingContent, newContent);
    const previewId = `preview-companion-gemini-${Date.now()}`;
    const previewHash = crypto.createHash("sha256").update(newContent).digest("hex");

    return {
      supported: true,
      adapter_id: this.id,
      host_id: this.id,
      scope: resolvedScope,
      preview_id: previewId,
      preview_hash: previewHash,
      target_file: targetFile,
      baseline_hash: null,
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
        error: preview.error || "Cannot apply companion registration for Gemini CLI.",
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
      message: "Gemini CLI companion registration applied successfully.",
    };
  }

  async validateCompanionRegistration(workspaceRoot?: string): Promise<ValidationResult> {
    const status = await this.inspectCompanionRegistration(workspaceRoot);
    return {
      valid: status.registered,
      workspace: workspaceRoot,
      message: status.registered
        ? "Gemini CLI companion MCP server registration validated successfully."
        : "Gemini CLI companion MCP server is not registered.",
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
    const targetFile = this.resolveConfigPath(workspace) || path.join(workspace, ".gemini", "config.json");

    const targetModel =
      plan.execution?.model ||
      plan.controller?.model ||
      profile?.single_model?.model;

    if (!targetModel) {
      throw new Error("Execution plan or profile does not specify a model for execution.");
    }

    let existingContent: string | null = null;
    let currentText = "{\n}\n";

    if (fs.existsSync(targetFile)) {
      existingContent = await fsp.readFile(targetFile, "utf-8");
      currentText = existingContent;
    }

    const formatting = { formattingOptions: { insertSpaces: true, tabSize: 2 } };
    let edits = jsonc.modify(currentText, ["model"], targetModel, formatting);
    currentText = jsonc.applyEdits(currentText, edits);

    const targetEffort =
      extractReasoningPolicy(plan.execution) ||
      extractReasoningPolicy(plan.controller);

    if (targetEffort) {
      edits = jsonc.modify(currentText, ["reasoning_effort"], targetEffort, formatting);
      currentText = jsonc.applyEdits(currentText, edits);
    }

    const diff = createUnifiedDiff(targetFile, existingContent, currentText);
    const previewId = `preview-gemini-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    return {
      preview_id: previewId,
      mutation_targets: [targetFile],
      diff,
      files: [{ path: targetFile, content: currentText }],
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
      message: `Gemini CLI configuration applied successfully to ${appliedTargets.length} target(s).`,
    };
  }

  async validateConfiguration(
    expected: ExecutionConfig,
    workspaceRoot?: string
  ): Promise<ValidationResult> {
    const workspace = workspaceRoot || process.cwd();
    const configPath = this.resolveConfigPath(workspace) || path.join(workspace, ".gemini", "config.json");

    if (!fs.existsSync(configPath)) {
      return {
        valid: false,
        workspace,
        message: `Gemini CLI configuration file '${configPath}' does not exist.`,
        errors: [`Missing configuration file: ${configPath}`],
      };
    }

    try {
      const content = await fsp.readFile(configPath, "utf-8");
      const parsed = jsonc.parse(content);
      const actualModel = parsed?.model;

      const expectedModel = expected.execution?.model || expected.controller?.model;
      const errors: string[] = [];

      if (expectedModel && actualModel !== expectedModel) {
        errors.push(
          `Model mismatch: expected '${expectedModel}' but actual configuration has '${actualModel}'`
        );
      }

      const valid = errors.length === 0;
      return {
        valid,
        workspace,
        message: valid
          ? "Gemini CLI configuration matches expected plan."
          : `Gemini CLI configuration drift detected: ${errors.join("; ")}`,
        errors: valid ? undefined : errors,
      };
    } catch (err: any) {
      return {
        valid: false,
        workspace,
        message: `Failed to parse Gemini CLI configuration: ${err.message}`,
        errors: [err.message],
      };
    }
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

  getGlobalGeminiDir(): string {
    if (process.env.GEMINI_CONFIG_DIR) {
      return process.env.GEMINI_CONFIG_DIR;
    }
    if (process.env.GEMINI_HOME) {
      return process.env.GEMINI_HOME;
    }
    return path.join(os.homedir(), ".gemini");
  }

  determineMcpRegistrationPath(workspace: string, scope?: "project" | "global" | "user"): string {
    if (scope === "global" || scope === "user" || !workspace) {
      const userCandidates = [
        path.join(os.homedir(), ".gemini", "config", "mcp_config.json"),
        path.join(os.homedir(), ".gemini", "mcp_config.json"),
        path.join(this.getGlobalGeminiDir(), "config.json"),
        path.join(os.homedir(), ".gemini", "config", "config.json"),
        path.join(os.homedir(), ".gemini", "config.json"),
      ];
      for (const c of userCandidates) {
        if (fs.existsSync(c)) return c;
      }
      return path.join(os.homedir(), ".gemini", "config", "mcp_config.json");
    }

    const candidates = [
      path.join(workspace, ".agents", "mcp_config.json"),
      path.join(workspace, ".gemini", "mcp_config.json"),
      path.join(workspace, ".gemini", "config.json"),
      path.join(workspace, ".gemini", "settings.json"),
      path.join(workspace, "gemini.json"),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    if (fs.existsSync(path.join(workspace, ".gemini"))) {
      return path.join(workspace, ".gemini", "config.json");
    }
    return path.join(workspace, ".agents", "mcp_config.json");
  }

  resolveConfigPath(workspace: string): string | null {
    const candidates = [
      path.join(workspace, ".gemini", "config.json"),
      path.join(workspace, ".gemini", "settings.json"),
      path.join(workspace, "gemini.json"),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    return null;
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
