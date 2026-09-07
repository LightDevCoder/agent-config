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
  CapabilityState,
  extractReasoningPolicy,
} from "../contract.js";
import { ExecutionConfig, AgentProfile } from "../../profile/schema.js";
import { createUnifiedDiff } from "../diff.js";

/**
 * Pi Coding Agent host adapter supporting authentic host detection,
 * project vs user configuration hierarchy, evidenced model discovery,
 * standard reasoning/thinking level configuration, and native MCP registration.
 */
export class PiAdapter implements HostAdapter {
  readonly id = "pi";
  readonly name = "Pi Coding Agent Adapter";
  readonly aliases = ["earendil-pi", "pi-coding-agent"];

  hasActiveRuntimeContext(_workspaceRoot?: string): boolean {
    if (
      process.env.PI_CODING_AGENT === "true" ||
      process.env.PI_CODING_AGENT === "1" ||
      process.env.AI_AGENT === "pi" ||
      (process.env.PI_SESSION_FILE && process.env.PI_SESSION_FILE !== "undefined") ||
      (process.env.PI_SESSION_ID && process.env.PI_SESSION_ID !== "undefined") ||
      (process.env.PI_MODEL && process.env.PI_MODEL !== "undefined") ||
      (process.env.PI_REASONING_LEVEL && process.env.PI_REASONING_LEVEL !== "undefined")
    ) {
      return true;
    }
    if (process.env._) {
      const bin = path.basename(process.env._).toLowerCase();
      if (bin === "pi" || bin.startsWith("pi-")) {
        return true;
      }
    }
    if (process.title) {
      const title = path.basename(process.title).toLowerCase();
      if (title === "pi" || title.startsWith("pi-")) {
        return true;
      }
    }
    return false;
  }

  async identifyHost(workspaceRoot?: string): Promise<boolean> {
    if (this.hasActiveRuntimeContext(workspaceRoot)) {
      return true;
    }

    if (workspaceRoot) {
      const candidates = [
        path.join(workspaceRoot, ".pi"),
        path.join(workspaceRoot, ".pi", "settings.json"),
        path.join(workspaceRoot, ".pi", "mcp.json"),
        path.join(workspaceRoot, "pi.json"),
      ];
      if (candidates.some((p) => fs.existsSync(p))) {
        return true;
      }
    }

    if (!workspaceRoot) {
      if (process.env.PI_CODING_AGENT_DIR && fs.existsSync(process.env.PI_CODING_AGENT_DIR)) {
        return true;
      }
      const globalCandidates = [
        path.join(this.getGlobalPiDir(), "settings.json"),
        path.join(this.getGlobalPiDir()),
        path.join(os.homedir(), ".pi", "agent"),
        path.join(os.homedir(), ".pi"),
      ];
      return globalCandidates.some((p) => fs.existsSync(p));
    }

    return false;
  }

  async inspectVersion(_workspaceRoot?: string): Promise<HostVersionInfo> {
    try {
      const result = childProcess.spawnSync("pi", ["--version"], { encoding: "utf-8", timeout: 1000 });
      const raw = result.stdout?.trim();
      const match = result.status === 0 && raw?.match(/^(?:pi\s+)?v?(\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?)$/);
      if (match) {
        const version = match[1];
        const supported = version === "0.85.1";
        return { version, raw, compatibility: supported ? "supported" : "partially-supported",
          fail_closed_for_mutation: !supported };
      }
    } catch { /* Version remains unknown. */ }
    return { compatibility: "unknown-version", fail_closed_for_mutation: true };
  }

  private async requireMutationVersion(workspace?: string): Promise<void> {
    const version = await this.inspectVersion(workspace);
    if (version.fail_closed_for_mutation) throw new Error("Pi version is unknown or unsupported for mutation.");
  }

  private modelPair(modelId: string, workspace?: string): { provider: string; model: string } | undefined {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(this.getGlobalPiDir(), "models.json"), "utf-8"));
      const pairs = Object.entries(data.providers || {}).flatMap(([provider, spec]: [string, any]) =>
        (spec.models || []).filter((m: any) => modelId === `${provider}/${m.id}` || modelId === m.id)
          .map((m: any) => ({ provider, model: m.id })));
      if (pairs.length) return pairs.length === 1 ? pairs[0] : undefined;
    } catch { /* Fall back only to pairing independent of the target file. */ }
    let globalConfig: any;
    try {
      globalConfig = JSON.parse(fs.readFileSync(path.join(this.getGlobalPiDir(), "settings.json"), "utf-8"));
    } catch { /* No global pairing evidence. */ }
    const activeModel = process.env.PI_MODEL || globalConfig?.defaultModel;
    const activeProvider = process.env.PI_MODEL ? process.env.PI_PROVIDER : globalConfig?.defaultProvider;
    if (activeProvider && (modelId === activeModel || modelId === `${activeProvider}/${activeModel}`)) {
      return { provider: activeProvider, model: activeModel };
    }
    // A qualified requested identity is fixed even when only project evidence exists.
    const config = this.readEffectiveConfig(workspace);
    if (config?.defaultProvider && modelId === `${config.defaultProvider}/${config.defaultModel}`) {
      return { provider: config.defaultProvider, model: config.defaultModel };
    }
    return undefined;
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

    // 1. Persistently trusted workspace settings
    if (workspaceRoot && this.projectTrusted(workspaceRoot)) {
      const projectSettingsPath = path.join(workspaceRoot, ".pi", "settings.json");
      if (fs.existsSync(projectSettingsPath)) {
        try {
          const content = fs.readFileSync(projectSettingsPath, "utf-8");
          const parsed = jsonc.parse(content);
          if (parsed && typeof parsed.defaultModel === "string") {
            addModel(parsed.defaultModel, parsed.defaultModel, projectSettingsPath);
          }
        } catch {
          // Skip read error
        }
      }
    }

    // 2. Active runtime environment
    if (process.env.PI_MODEL) {
      const modelId = process.env.PI_MODEL.trim();
      if (!seen.has(modelId)) {
        seen.add(modelId);
        models.push({
          id: modelId,
          label: modelId,
          state: "available",
          features: ["tools"],
          evidence: {
            kind: "host-runtime",
            locator: "process.env.PI_MODEL",
          },
        });
      }
    }

    // 3. Global settings.json
    const globalSettingsPath = path.join(this.getGlobalPiDir(), "settings.json");
    if (fs.existsSync(globalSettingsPath)) {
      try {
        const content = fs.readFileSync(globalSettingsPath, "utf-8");
        const parsed = jsonc.parse(content);
        if (parsed && typeof parsed.defaultModel === "string") {
          addModel(parsed.defaultModel, parsed.defaultModel, globalSettingsPath);
        }
      } catch {
        // Skip read error
      }
    }

    // 4. Global cliproxyapi-models.json
    const cliproxyPath = path.join(this.getGlobalPiDir(), "cliproxyapi-models.json");
    if (fs.existsSync(cliproxyPath)) {
      try {
        const content = fs.readFileSync(cliproxyPath, "utf-8");
        const parsed = jsonc.parse(content);
        if (parsed && Array.isArray(parsed.models)) {
          for (const item of parsed.models) {
            if (item && typeof item.id === "string") {
              const features = ["tools"];
              if (item.reasoning) features.push("reasoning");
              addModel(item.id, item.name || item.id, cliproxyPath, features);
            }
          }
        }
      } catch {
        // Skip read error
      }
    }

    // 5. Global models-store.json
    const modelsStorePath = path.join(this.getGlobalPiDir(), "models-store.json");
    if (fs.existsSync(modelsStorePath)) {
      try {
        const content = fs.readFileSync(modelsStorePath, "utf-8");
        const parsed = jsonc.parse(content);
        if (parsed && Array.isArray(parsed.models)) {
          for (const item of parsed.models) {
            if (item && typeof item.id === "string") {
              addModel(item.id, item.name || item.id, modelsStorePath);
            }
          }
        }
      } catch {
        // Skip read error
      }
    }

    // Native models.json preserves provider identity for cross-provider selection.
    const nativeModels = path.join(this.getGlobalPiDir(), "models.json");
    try {
      const data = JSON.parse(fs.readFileSync(nativeModels, "utf-8"));
      for (const [provider, spec] of Object.entries(data.providers || {}) as [string, any][]) {
        for (const model of spec.models || []) {
          if (typeof model.id === "string") addModel(`${provider}/${model.id}`, model.name || model.id, nativeModels);
        }
      }
    } catch { /* Native model inventory remains unconfirmed. */ }

    return models.filter((model) => this.modelPair(model.id, workspaceRoot) !== undefined);
  }

  async inspectEffortValues(workspaceRoot?: string): Promise<string[]> {
    const options = await this.inspectReasoningOptions(workspaceRoot);
    return options.supported_values;
  }

  async inspectReasoningOptions(workspaceRoot?: string, modelId?: string): Promise<HostReasoningOptions> {
    const config = this.readEffectiveConfig(workspaceRoot);
    const activeModel = process.env.PI_MODEL || config?.defaultModel;
    const pair = modelId ? this.modelPair(modelId, workspaceRoot) : undefined;
    const targetModel = pair?.model || modelId || activeModel;
    const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
    let supported: string[] = [];
    // Model maps have null holes; an arbitrary settings file is not model evidence.
    for (const filename of ["models.json", "cliproxyapi-models.json", "models-store.json"]) {
      const source = path.join(this.getGlobalPiDir(), filename);
      if (!fs.existsSync(source)) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(source, "utf-8"));
        const provider = pair?.provider || process.env.PI_PROVIDER || config?.defaultProvider;
        const entries = parsed.models || parsed.providers?.[provider]?.models || [];
        const model = entries.find((entry: any) => entry.id === targetModel);
        if (model?.reasoning === false) { supported = ["off"]; break; }
        if (model?.reasoning === true && model.thinkingLevelMap) {
          supported = levels.filter((level, index) =>
            typeof model.thinkingLevelMap[level] === "string" ||
            (index <= 4 && model.thinkingLevelMap[level] === undefined));
          break;
        }
      } catch { /* Unreadable or malformed model evidence stays unknown. */ }
    }
    const observed = process.env.PI_REASONING_LEVEL;
    if (!supported.length && targetModel === activeModel && observed && levels.includes(observed)) {
      supported = [observed];
    }
    const configured = config?.modelThinkingLevels?.[`${process.env.PI_PROVIDER || config?.defaultProvider}/${targetModel}`]
      || config?.defaultThinkingLevel;
    const defaultValue = targetModel === activeModel && observed ? observed : configured;
    return {
      native_field: "defaultThinkingLevel",
      supported_values: supported,
      default_value: supported.includes(defaultValue) ? defaultValue : undefined,
    };
  }

  async inspectExecutionTopologyCapabilities(_workspaceRoot?: string): Promise<TopologyCapabilities> {
    return {
      supports_single_session: true,
      supports_subagents: false,
      supports_multi_agent: false,
      supports_parallel_execution: false,
      scopes: ["current-session", "new-session"],
    };
  }

  async inspectCapabilities(workspaceRoot?: string): Promise<HostCapabilities> {
    const models = await this.inspectModels(workspaceRoot);
    const version = await this.inspectVersion(workspaceRoot);
    const reasoningOpts = await this.inspectReasoningOptions(workspaceRoot);

    const hasReasoning = reasoningOpts.supported_values.length > 0;
    const targetConfigPath = this.determineTargetConfigPath(workspaceRoot || process.cwd());

    const reasoningState: CapabilityState = hasReasoning ? "available" : "unknown";
    const modelsState: CapabilityState = models.length > 0 ? "available" : "unknown";

    return {
      host_id: "pi",
      adapter_id: "pi",
      workspace: workspaceRoot,
      observed_at: new Date().toISOString(),
      platform: `${os.platform()}-${os.arch()}`,
      available_models: models,
      supported_effort_values: reasoningOpts.supported_values,
      default_effort_value: reasoningOpts.default_value,
      capabilities: {
        subagents: { state: "unknown" },
        threads: {
          state: "available",
          evidence: {
            kind: "host-runtime",
            locator: ".pi session store / PI_SESSION_FILE",
          },
        },
        parallelism: { state: "unknown" },
        model_selection: {
          state: modelsState,
          scopes: ["current-session", "new-session"],
          ...(modelsState === "available"
            ? {
                evidence: {
                  kind: "host-config",
                  locator: targetConfigPath,
                },
              }
            : {}),
        },
        per_agent_model_selection: { state: "unknown" },
        concurrency: { state: "unknown" },
        configuration_mutation: {
          state: version.fail_closed_for_mutation ? "unknown" : "available",
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

  private projectTrusted(workspace: string): boolean {
    let current = fs.existsSync(workspace) ? fs.realpathSync(workspace) : path.resolve(workspace);
    try {
      const trust = JSON.parse(fs.readFileSync(path.join(this.getGlobalPiDir(), "trust.json"), "utf-8"));
      while (true) {
        if (typeof trust[current] === "boolean") return trust[current];
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
      }
    } catch { /* No usable persisted trust decision. */ }
    try {
      return JSON.parse(fs.readFileSync(path.join(this.getGlobalPiDir(), "settings.json"), "utf-8")).defaultProjectTrust === "always";
    } catch { return false; }
  }

  private hasMcpExtension(workspaceRoot?: string): boolean {
    const roots = [this.getGlobalPiDir(), ...(workspaceRoot && this.projectTrusted(workspaceRoot) ? [path.join(workspaceRoot, ".pi")] : [])];
    return roots.some((root) => {
      try {
        const settings = JSON.parse(fs.readFileSync(path.join(root, "settings.json"), "utf-8"));
        const enabled = settings.packages?.some((entry: any) => {
          const source = typeof entry === "string" ? entry : entry?.source;
          return typeof source === "string" && /^npm:pi-mcp-adapter(?:@[^/]+)?$/.test(source)
            && !(typeof entry === "object" && Array.isArray(entry.extensions) && entry.extensions.length === 0);
        });
        const manifest = JSON.parse(fs.readFileSync(path.join(root, "npm", "node_modules", "pi-mcp-adapter", "package.json"), "utf-8"));
        return enabled && manifest.name === "pi-mcp-adapter";
      } catch { return false; }
    });
  }

  async inspectCompanionRegistration(
    workspaceRoot?: string,
    scope?: "project" | "global" | "user"
  ): Promise<CompanionRegistrationStatus> {
    const workspace = workspaceRoot || process.cwd();
    const globalScope = scope === "global" || scope === "user" || (!scope && !workspaceRoot);
    const target = this.determineMcpRegistrationPath(workspace, scope);
    const base = { registered: false, scope: globalScope ? "global" as const : "project" as const,
      target_file: target, locator: target };
    if (!this.hasMcpExtension(globalScope ? undefined : workspaceRoot)) {
      return { ...base, details: { reason: "Install and enable npm:pi-mcp-adapter, then restart Pi. Core Pi does not load MCP files." } };
    }
    const candidates = [
      ...(scope !== "project" ? [path.join(os.homedir(), ".config", "mcp", "mcp.json"),
        path.join(os.homedir(), ".agents", "mcp.json"), path.join(os.homedir(), ".agents", "mcp", "mcp.json"),
        path.join(this.getGlobalPiDir(), "mcp.json")] : []),
      ...(!globalScope ? [path.join(workspace, ".mcp.json"), path.join(workspace, ".pi", "mcp.json")] : []),
    ];
    let server: any;
    let locator = target;
    for (const file of candidates) {
      if (!fs.existsSync(file)) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
        if (parsed?.mcpServers?.["agent-config"]) {
          server = { ...server, ...parsed.mcpServers["agent-config"] };
          locator = file;
        }
      } catch { return { ...base, details: { reason: `Malformed MCP configuration: ${file}` } }; }
    }
    if (!server || server.disabled || typeof server.command !== "string" || !server.command.trim()) return base;
    return { ...base, registered: true, transport: "stdio", locator, target_file: locator,
      command: server.command, args: server.args, details: { ...server, runtime: "Restart/reload and live health probe required" } };
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
    const version = await this.inspectVersion(workspaceRoot);
    if (version.fail_closed_for_mutation) {
      return { supported: false, adapter_id: this.id, host_id: this.id, scope: resolvedScope,
        target_file: targetFile, mutation_targets: [], error: "Pi version is unknown or unsupported for mutation." };
    }
    if (!this.hasMcpExtension(resolvedScope === "global" ? undefined : workspaceRoot)) {
      return { supported: false, adapter_id: this.id, host_id: this.id, scope: resolvedScope,
        target_file: targetFile, mutation_targets: [],
        error: "Install and enable npm:pi-mcp-adapter, then restart Pi before companion registration." };
    }

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
          error: `Pi configuration file at '${targetFile}' contains syntax errors. Rejecting companion registration to prevent loss.`,
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
    const previewId = `preview-companion-pi-${Date.now()}`;
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
        error: preview.error || "Cannot apply companion registration for Pi.",
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

    try { await this.requireMutationVersion(workspaceRoot); } catch (error: any) {
      return { success: false, preview_id: previewHash, applied_targets: [], error: error.message };
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
      message: "Pi companion registration applied successfully.",
    };
  }

  async validateCompanionRegistration(workspaceRoot?: string): Promise<ValidationResult> {
    const status = await this.inspectCompanionRegistration(workspaceRoot);
    return {
      valid: status.registered,
      workspace: workspaceRoot,
      message: status.registered
        ? "Pi companion registration files verified; restart/reload and a live health probe are still required."
        : "Pi companion MCP server is not registered.",
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
    await this.requireMutationVersion(workspaceRoot);
    const workspace = workspaceRoot || process.cwd();
    const targetFile = this.determineTargetConfigPath(workspace);

    const targetModel =
      plan.execution?.model ||
      plan.controller?.model ||
      profile?.single_model?.model;

    if (!targetModel) {
      throw new Error("Execution plan or profile does not specify a model for execution.");
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
          `Pi configuration file at '${targetFile}' contains syntax errors. Rejecting mutation to prevent configuration loss.`
        );
      }
      initialText = existingContent;
    }

    const formatting = { formattingOptions: { insertSpaces: true, tabSize: 2 } };
    let currentText = initialText;

    const pair = this.modelPair(targetModel, workspace);
    if (!pair) throw new Error(`Pi provider/model pair is not evidenced for '${targetModel}'.`);
    currentText = jsonc.applyEdits(currentText, jsonc.modify(currentText, ["defaultProvider"], pair.provider, formatting));
    // Update both parts of Pi's startup model identity.
    const modelEdits = jsonc.modify(currentText, ["defaultModel"], pair.model, formatting);
    currentText = jsonc.applyEdits(currentText, modelEdits);

    // 2. If targetEffort specified, resolve and update defaultThinkingLevel
    if (targetEffort) {
      const resolved = await this.resolveReasoningPolicy(targetEffort, targetModel, workspace);
      if (!resolved) throw new Error(`Unevidenced Pi thinking level: ${targetEffort}`);
      const thinkingLevel = resolved.host_value;
      const thinkingEdits = jsonc.modify(
        currentText,
        ["defaultThinkingLevel"],
        thinkingLevel,
        formatting
      );
      currentText = jsonc.applyEdits(currentText, thinkingEdits);
      const pairKey = `${pair.provider}/${pair.model}`;
      if (this.readEffectiveConfig(workspace)?.modelThinkingLevels?.[pairKey] !== undefined) {
        currentText = jsonc.applyEdits(currentText,
          jsonc.modify(currentText, ["modelThinkingLevels", pairKey], thinkingLevel, formatting));
      }
    }

    const files: RenderedFile[] = [
      {
        path: targetFile,
        content: currentText,
      },
    ];

    const diff = createUnifiedDiff(targetFile, existingContent, currentText);
    const previewId = `preview-pi-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    return {
      preview_id: previewId,
      mutation_targets: [targetFile],
      diff,
      files,
      raw: {
        model: targetModel,
        thinking: targetEffort,
      },
    };
  }

  async applyConfiguration(
    previewId: string,
    rendered?: RenderedConfiguration,
    workspaceRoot?: string
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

    try { await this.requireMutationVersion(workspaceRoot); } catch (error: any) {
      return { success: false, preview_id: previewId, applied_targets: [], error: error.message };
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
      message: `Pi configuration applied successfully to ${appliedTargets.length} target(s).`,
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
        message: `Pi configuration file '${targetFile}' does not exist.`,
        errors: [`Missing configuration file: ${targetFile}`],
      };
    }

    if (!this.projectTrusted(workspace)) {
      return { valid: false, workspace,
        message: "Project settings were written, but Pi project trust is not confirmed; trust the project in Pi and restart before validating.",
        errors: ["Unconfirmed Pi project trust"] };
    }

    let parsed: any;
    try {
      const content = await fsp.readFile(targetFile, "utf-8");
      const parseErrors: jsonc.ParseError[] = [];
      parsed = jsonc.parse(content, parseErrors, { allowTrailingComma: true });
      if (parseErrors.length || !parsed || Array.isArray(parsed) || typeof parsed !== "object") {
        throw new Error("Invalid Pi settings object");
      }
    } catch (e: any) {
      return {
        valid: false,
        workspace,
        message: `Failed to parse Pi configuration: ${e.message}`,
        errors: [e.message],
      };
    }

    const errors: string[] = [];
    const expectedModel = expected.execution?.model || expected.controller?.model;

    const expectedPair = expectedModel ? this.modelPair(expectedModel, workspace) : undefined;
    if (expectedModel && (!expectedPair || parsed?.defaultProvider !== expectedPair.provider || parsed?.defaultModel !== expectedPair.model)) {
      errors.push(
        `defaultProvider/defaultModel mismatch: expected '${expectedModel}', got '${parsed?.defaultModel}'`
      );
    }

    const expectedEffort =
      extractReasoningPolicy(expected.execution) ||
      extractReasoningPolicy(expected.controller);

    if (expectedEffort) {
      const resolved = await this.resolveReasoningPolicy(expectedEffort, expectedModel, workspace);
      const expectedThinking = resolved?.host_value || expectedEffort;
      const pairKey = expectedPair ? `${expectedPair.provider}/${expectedPair.model}` : undefined;
      const effective = this.readEffectiveConfig(workspace);
      const actualThinking = (pairKey ? effective?.modelThinkingLevels?.[pairKey] : undefined)
        ?? parsed?.defaultThinkingLevel;
      if (!resolved || actualThinking !== expectedThinking) {
        errors.push(
          `Thinking level mismatch: expected '${expectedThinking}', got '${actualThinking}'`
        );
      }
    }

    return {
      valid: errors.length === 0,
      workspace,
      message:
        errors.length === 0
          ? "Pi configuration matches expected state."
          : `Configuration validation failed with ${errors.length} error(s).`,
      errors: errors.length > 0 ? errors : undefined,
    };
  }

  async resolveReasoningPolicy(
    policy: string,
    _modelId?: string,
    workspaceRoot?: string
  ): Promise<ResolvedReasoningPolicy | undefined> {
    const options = await this.inspectReasoningOptions(workspaceRoot, _modelId);
    const supported = options.supported_values;
    const normalized = policy.toLowerCase().trim();

    if (supported.length === 0) {
      return undefined;
    }

    let resolvedValue: string | undefined;
    if (normalized === "highest-supported") {
      resolvedValue = supported[supported.length - 1];
    } else if (normalized === "lowest-sufficient" || normalized === "lowest-supported") {
      if (supported.includes("off")) resolvedValue = "off";
      else if (supported.includes("minimal")) resolvedValue = "minimal";
      else if (supported.includes("low")) resolvedValue = "low";
      else resolvedValue = supported[0];
    } else if (normalized === "configured") {
      resolvedValue = options.default_value;
    } else if (supported.includes(normalized)) {
      resolvedValue = normalized;
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

  // --- Helpers ---

  getGlobalPiDir(): string {
    return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  }

  determineTargetConfigPath(workspace: string, scope?: "project" | "global" | "user"): string {
    if (scope === "global" || scope === "user" || !workspace) {
      return path.join(this.getGlobalPiDir(), "settings.json");
    }
    return path.join(workspace, ".pi", "settings.json");
  }

  determineMcpRegistrationPath(workspace: string, scope?: "project" | "global" | "user"): string {
    if (scope === "global" || scope === "user" || !workspace) {
      return path.join(this.getGlobalPiDir(), "mcp.json");
    }
    return path.join(workspace, ".pi", "mcp.json");
  }

  readEffectiveConfig(workspaceRoot?: string): Record<string, any> | null {
    let result: Record<string, any> = {};
    let found = false;

    // 1. Read global settings
    const globalSettings = path.join(this.getGlobalPiDir(), "settings.json");
    if (fs.existsSync(globalSettings)) {
      try {
        const parsed = jsonc.parse(fs.readFileSync(globalSettings, "utf-8"));
        if (parsed && typeof parsed === "object") {
          result = { ...result, ...parsed };
          found = true;
        }
      } catch {
        // Skip
      }
    }

    // 2. Pi ignores project settings until that project is trusted.
    if (workspaceRoot && this.projectTrusted(workspaceRoot)) {
      const projectSettings = path.join(workspaceRoot, ".pi", "settings.json");
      if (fs.existsSync(projectSettings)) {
        try {
          const parsed = jsonc.parse(fs.readFileSync(projectSettings, "utf-8"));
          if (parsed && typeof parsed === "object") {
            const modelThinkingLevels = { ...result.modelThinkingLevels, ...parsed.modelThinkingLevels };
            result = { ...result, ...parsed, modelThinkingLevels };
            found = true;
          }
        } catch {
          // Skip
        }
      }
    }

    return found ? result : null;
  }
}
