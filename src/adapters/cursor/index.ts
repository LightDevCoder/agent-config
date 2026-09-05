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
 * Cursor native adapter covering Cursor Agent CLI and Editor capabilities,
 * editor/CLI shared MCP configuration across project and global scopes,
 * host CLI command inspection prioritization for MCP status, model controls,
 * background/parallel agent inspection, and headless operation detection.
 */
export class CursorAdapter implements HostAdapter {
  readonly id = "cursor";
  readonly name = "Cursor Adapter";

  hasActiveRuntimeContext(_workspaceRoot?: string): boolean {
    if (
      process.env.CURSOR_CLI === "1" ||
      process.env.CURSOR_CLI === "true" ||
      process.env.CURSOR_AGENT === "1" ||
      process.env.CURSOR_AGENT === "true" ||
      (process.env.CURSOR_SESSION_ID && process.env.CURSOR_SESSION_ID !== "undefined") ||
      (process.env.CURSOR_PROJECT_DIR && process.env.CURSOR_PROJECT_DIR !== "undefined") ||
      (process.env.CURSOR_CONFIG_DIR && process.env.CURSOR_CONFIG_DIR !== "undefined")
    ) {
      return true;
    }

    if (process.env._ && path.basename(process.env._).toLowerCase().includes("cursor")) {
      return true;
    }
    if (process.title && path.basename(process.title).toLowerCase().includes("cursor")) {
      return true;
    }
    return false;
  }

  isHeadlessExecution(_workspaceRoot?: string): boolean {
    if (
      process.env.CURSOR_HEADLESS === "1" ||
      process.env.CURSOR_HEADLESS === "true" ||
      process.env.CURSOR_NON_INTERACTIVE === "1" ||
      process.env.CURSOR_NON_INTERACTIVE === "true" ||
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
        path.join(workspaceRoot, ".cursor"),
        path.join(workspaceRoot, ".cursor", "settings.json"),
        path.join(workspaceRoot, ".cursor", "mcp.json"),
        path.join(workspaceRoot, ".cursorrules"),
      ];
      if (candidates.some((p) => fs.existsSync(p))) {
        return true;
      }
    }

    if (process.env.CURSOR_CONFIG_DIR && fs.existsSync(process.env.CURSOR_CONFIG_DIR)) {
      return true;
    }

    if (!workspaceRoot) {
      const globalCandidates = [
        this.getGlobalCursorDir(),
        path.join(os.homedir(), ".cursor"),
        path.join(os.homedir(), ".cursor", "settings.json"),
        path.join(os.homedir(), ".cursor", "mcp.json"),
        path.join(os.homedir(), ".config", "Cursor"),
      ];
      return globalCandidates.some((p) => fs.existsSync(p));
    }

    return false;
  }

  async inspectVersion(workspaceRoot?: string): Promise<HostVersionInfo> {
    let version = process.env.CURSOR_VERSION || process.env.CURSOR_CLI_VERSION;
    let raw: string | undefined = version;

    if (!version) {
      const cliResult = await this.runCliCommand("cursor", ["--version"], workspaceRoot);
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

    if (!version && workspaceRoot) {
      const versionFile = path.join(workspaceRoot, ".cursor", "version");
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
      const globalVersionFile = path.join(this.getGlobalCursorDir(), "version");
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

  readEffectiveSettings(workspaceRoot?: string): {
    settings: Record<string, any>;
    sourcePath?: string;
    isProject: boolean;
  } | null {
    const workspace = workspaceRoot || process.cwd();

    // 1. Project-level settings (highest precedence)
    const projectCandidates = [
      path.join(workspace, ".cursor", "settings.json"),
    ];

    for (const p of projectCandidates) {
      if (fs.existsSync(p)) {
        try {
          const content = fs.readFileSync(p, "utf-8");
          const parsed = jsonc.parse(content);
          if (parsed && typeof parsed === "object") {
            return { settings: parsed, sourcePath: p, isProject: true };
          }
        } catch {
          // Skip parse error
        }
      }
    }

    // 2. User-level settings
    const userCandidates = [
      path.join(this.getGlobalCursorDir(), "settings.json"),
      path.join(os.homedir(), ".cursor", "settings.json"),
      path.join(os.homedir(), ".config", "Cursor", "User", "settings.json"),
    ];

    for (const p of userCandidates) {
      if (fs.existsSync(p)) {
        try {
          const content = fs.readFileSync(p, "utf-8");
          const parsed = jsonc.parse(content);
          if (parsed && typeof parsed === "object") {
            return { settings: parsed, sourcePath: p, isProject: false };
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

    const effective = this.readEffectiveSettings(workspaceRoot);
    if (effective) {
      const cfg = effective.settings;
      const locator = effective.sourcePath || "cursor-settings";

      const modelVal = cfg["cursor.model"] || cfg.model;
      if (typeof modelVal === "string" && modelVal.trim().length > 0) {
        const id = modelVal.trim();
        if (!seen.has(id)) {
          seen.add(id);
          models.push({
            id,
            label: id,
            state: "available",
            features: ["cursor-agent"],
            evidence: { kind: "host-config", locator },
          });
        }
      }

      const modelsList = cfg["cursor.models"] || cfg.models;
      if (Array.isArray(modelsList)) {
        for (const m of modelsList) {
          if (typeof m === "string" && m.trim().length > 0) {
            const id = m.trim();
            if (!seen.has(id)) {
              seen.add(id);
              models.push({
                id,
                label: id,
                state: "available",
                features: ["cursor-agent"],
                evidence: { kind: "host-config", locator },
              });
            }
          }
        }
      }
    }

    if (process.env.CURSOR_MODEL && process.env.CURSOR_MODEL.trim().length > 0) {
      const id = process.env.CURSOR_MODEL.trim();
      if (!seen.has(id)) {
        seen.add(id);
        models.push({
          id,
          label: id,
          state: "available",
          features: ["cursor-agent"],
          evidence: { kind: "host-runtime", locator: "env:CURSOR_MODEL" },
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
    const effective = this.readEffectiveSettings(workspaceRoot);
    let reasoningVal = process.env.CURSOR_REASONING_EFFORT;

    if (!reasoningVal && effective) {
      reasoningVal =
        effective.settings["cursor.reasoningEffort"] ||
        effective.settings["cursor.reasoning"] ||
        effective.settings["cursor.thinking"];
    }

    if (reasoningVal) {
      const valStr = String(reasoningVal);
      return {
        native_field: "cursor.reasoningEffort",
        supported_values: [valStr],
        default_value: valStr,
      };
    }

    return {
      native_field: "cursor.reasoningEffort",
      supported_values: [],
    };
  }

  async inspectExecutionTopologyCapabilities(
    workspaceRoot?: string
  ): Promise<TopologyCapabilities> {
    const effective = this.readEffectiveSettings(workspaceRoot);
    const cfg = effective?.settings || {};

    const parallelEnabled = Boolean(
      cfg["cursor.parallelAgents"] === true ||
      cfg["cursor.composer.parallelAgents"] === true ||
      cfg["cursor.backgroundAgent"] === true ||
      process.env.CURSOR_PARALLEL_AGENTS === "1"
    );

    if (parallelEnabled) {
      const concurrencyVal = cfg["cursor.maxConcurrency"] || cfg["cursor.concurrency"];
      const concurrency = typeof concurrencyVal === "number" && concurrencyVal > 0 ? concurrencyVal : undefined;
      return {
        supports_single_session: true,
        supports_subagents: true,
        supports_multi_agent: true,
        supports_parallel_execution: true,
        max_concurrency: concurrency,
      };
    }

    return {
      supports_single_session: true,
      supports_subagents: false,
      supports_multi_agent: false,
      supports_parallel_execution: false,
      max_concurrency: 1,
    };
  }

  async inspectCapabilities(workspaceRoot?: string): Promise<HostCapabilities> {
    const models = await this.inspectModels(workspaceRoot);
    const reasoningOpts = await this.inspectReasoningOptions(workspaceRoot);
    const topology = await this.inspectExecutionTopologyCapabilities(workspaceRoot);

    const hasReasoning = reasoningOpts.supported_values.length > 0;
    const hasModels = models.length > 0;
    const isParallel = topology.supports_parallel_execution;

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
          state: isParallel ? "available" : "unknown",
          evidence: isParallel
            ? { kind: "host-config", locator: "cursor.parallelAgents" }
            : undefined,
        },
        per_agent_model_selection: {
          state: isParallel ? "available" : "unknown",
        },
        threads: {
          state: isParallel ? "available" : "unknown",
        },
        parallelism: {
          state: isParallel ? "available" : "unknown",
        },
        concurrency: {
          state: isParallel ? "available" : "unknown",
          max_concurrency: isParallel ? topology.max_concurrency : undefined,
        },
        model_selection: {
          state: hasModels ? "available" : "unknown",
          scopes: hasModels ? ["current-session", "new-session"] : undefined,
        },
        reasoning: {
          state: hasReasoning ? "available" : "unknown",
        },
        configuration_mutation: {
          state: "available",
          supports_native_files: true,
          supports_session_mutation: false,
        },
      },
    };
  }

  /**
   * Inspects MCP servers across host CLI command and project/global file scopes (§36).
   * Prioritizes host CLI command inspection over raw config file parsing.
   */
  async inspectMcpServers(workspaceRoot?: string): Promise<{
    servers: Record<string, any>;
    source: "host-command" | "workspace-config" | "user-config";
    locator: string;
  } | null> {
    // 1. Prioritize host CLI inspection commands
    const cliResult = await this.runCliCommand("cursor", ["mcp", "list", "--json"], workspaceRoot);
    if (cliResult && cliResult.stdout.trim().length > 0) {
      try {
        const parsed = JSON.parse(cliResult.stdout.trim());
        const servers = parsed.mcpServers || parsed.servers || parsed;
        if (servers && typeof servers === "object") {
          return {
            servers,
            source: "host-command",
            locator: "cursor mcp list --json",
          };
        }
      } catch {
        // Fallback to file parsing
      }
    }

    // 2. Project scope (.cursor/mcp.json)
    const workspace = workspaceRoot || process.cwd();
    const wsMcpPath = path.join(workspace, ".cursor", "mcp.json");
    if (fs.existsSync(wsMcpPath)) {
      try {
        const content = fs.readFileSync(wsMcpPath, "utf-8");
        const parsed = jsonc.parse(content);
        if (parsed?.mcpServers && typeof parsed.mcpServers === "object") {
          return {
            servers: parsed.mcpServers,
            source: "workspace-config",
            locator: wsMcpPath,
          };
        }
      } catch {
        // Fallback
      }
    }

    // 3. User scope (~/.cursor/mcp.json)
    const globalMcpPath = path.join(this.getGlobalCursorDir(), "mcp.json");
    if (fs.existsSync(globalMcpPath)) {
      try {
        const content = fs.readFileSync(globalMcpPath, "utf-8");
        const parsed = jsonc.parse(content);
        if (parsed?.mcpServers && typeof parsed.mcpServers === "object") {
          return {
            servers: parsed.mcpServers,
            source: "user-config",
            locator: globalMcpPath,
          };
        }
      } catch {
        // Fallback
      }
    }

    return null;
  }

  async inspectCompanionRegistration(
    workspaceRoot?: string,
    scope?: "project" | "global" | "user"
  ): Promise<CompanionRegistrationStatus> {
    const workspace = workspaceRoot || process.cwd();

    const mcpInfo = await this.inspectMcpServers(workspaceRoot);
    if (mcpInfo && mcpInfo.servers["agent-config"]) {
      const serverConfig = mcpInfo.servers["agent-config"];
      const isWorkspace = mcpInfo.locator.startsWith(workspace);
      return {
        registered: true,
        transport: "stdio",
        scope: (scope === "global" ? "global" : isWorkspace ? "project" : "global"),
        locator: mcpInfo.locator,
        command: serverConfig.command,
        args: serverConfig.args,
        target_file: mcpInfo.locator.includes(".json") ? mcpInfo.locator : undefined,
        details: { source: mcpInfo.source, config: serverConfig },
      };
    }

    const resolvedScope: "project" | "global" =
      scope === "global" || scope === "user" || (!scope && !workspaceRoot)
        ? "global"
        : "project";
    const defaultTarget =
      resolvedScope === "global"
        ? path.join(this.getGlobalCursorDir(), "mcp.json")
        : path.join(workspace, ".cursor", "mcp.json");
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
    const targetFile =
      resolvedScope === "global"
        ? path.join(this.getGlobalCursorDir(), "mcp.json")
        : path.join(workspace, ".cursor", "mcp.json");

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
          error: `Cursor MCP configuration file at '${targetFile}' contains syntax errors. Rejecting companion registration to prevent data loss.`,
        };
      }
      initialText = existingContent;
    }

    const formatting = { formattingOptions: { insertSpaces: true, tabSize: 2 } };
    const edits = jsonc.modify(
      initialText,
      ["mcpServers", "agent-config"],
      { command: "agent-config", args: ["serve"] },
      formatting
    );
    const newContent = jsonc.applyEdits(initialText, edits);
    const diff = createUnifiedDiff(targetFile, existingContent, newContent);
    const previewId = `preview-companion-cursor-${Date.now()}`;
    const previewHash = crypto.createHash("sha256").update(newContent).digest("hex");
    const baselineHash = existingContent
      ? crypto.createHash("sha256").update(existingContent).digest("hex")
      : null;

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
        error: preview.error || "Cannot apply companion registration for Cursor.",
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
      message: "Cursor companion registration applied successfully.",
    };
  }

  async validateCompanionRegistration(workspaceRoot?: string): Promise<ValidationResult> {
    const status = await this.inspectCompanionRegistration(workspaceRoot);
    return {
      valid: status.registered,
      workspace: workspaceRoot,
      message: status.registered
        ? "Cursor companion MCP server registration validated successfully."
        : "Cursor companion MCP server is not registered.",
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
    const targetFile = this.resolveSettingsPath(workspace) || path.join(workspace, ".cursor", "settings.json");

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
    let edits = jsonc.modify(currentText, ["cursor.model"], targetModel, formatting);
    currentText = jsonc.applyEdits(currentText, edits);

    const targetEffort =
      extractReasoningPolicy(plan.execution) ||
      extractReasoningPolicy(plan.controller);

    if (targetEffort) {
      edits = jsonc.modify(currentText, ["cursor.reasoningEffort"], targetEffort, formatting);
      currentText = jsonc.applyEdits(currentText, edits);
    }

    const diff = createUnifiedDiff(targetFile, existingContent, currentText);
    const previewId = `preview-cursor-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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
      message: `Cursor configuration applied successfully to ${appliedTargets.length} target(s).`,
    };
  }

  async validateConfiguration(
    expected: ExecutionConfig,
    workspaceRoot?: string
  ): Promise<ValidationResult> {
    const workspace = workspaceRoot || process.cwd();
    const configPath = this.resolveSettingsPath(workspace) || path.join(workspace, ".cursor", "settings.json");

    if (!fs.existsSync(configPath)) {
      return {
        valid: false,
        workspace,
        message: `Cursor configuration file '${configPath}' does not exist.`,
        errors: [`Missing configuration file: ${configPath}`],
      };
    }

    try {
      const content = await fsp.readFile(configPath, "utf-8");
      const parsed = jsonc.parse(content);
      const actualModel = parsed?.["cursor.model"] || parsed?.model;

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
          ? "Cursor configuration matches expected plan."
          : `Cursor configuration drift detected: ${errors.join("; ")}`,
        errors: valid ? undefined : errors,
      };
    } catch (err: any) {
      return {
        valid: false,
        workspace,
        message: `Failed to parse Cursor configuration: ${err.message}`,
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
      host_field: "cursor.reasoningEffort",
      host_value: resolvedValue,
    };
  }

  // --- Internal Helpers ---

  getGlobalCursorDir(): string {
    if (process.env.CURSOR_CONFIG_DIR) {
      return process.env.CURSOR_CONFIG_DIR;
    }
    return path.join(os.homedir(), ".cursor");
  }

  resolveSettingsPath(workspace: string): string | null {
    const candidates = [
      path.join(workspace, ".cursor", "settings.json"),
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
