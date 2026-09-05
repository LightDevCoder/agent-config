import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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

const execFileAsync = promisify(execFile);

/**
 * ZCode Native Host Adapter grounded in host runtime evidence (§2, §7, §10, §45).
 * Verified against local ZCode installation:
 * - Desktop App: /Applications/ZCode.app (version 3.11.2)
 * - CLI bundle: /Applications/ZCode.app/Contents/Resources/glm/zcode.cjs (version 0.16.5)
 * - Config: ~/.zcode/cli/config.json, ~/.zcode/v2/config.json, <workspace>/.zcode/config.json
 */
export class ZCodeAdapter implements HostAdapter {
  readonly id = "zcode";
  readonly name = "ZCode Native Adapter";

  private getAppBundlePath(): string | undefined {
    const defaultApp = "/Applications/ZCode.app";
    if (fs.existsSync(defaultApp)) {
      return defaultApp;
    }
    return undefined;
  }

  private getCliBundlePath(): string | undefined {
    const app = this.getAppBundlePath();
    if (app) {
      const cliPath = path.join(app, "Contents", "Resources", "glm", "zcode.cjs");
      if (fs.existsSync(cliPath)) {
        return cliPath;
      }
    }
    return undefined;
  }

  hasActiveRuntimeContext(_workspaceRoot?: string): boolean {
    if (
      (process.env.ZCODE_SESSION_ID && process.env.ZCODE_SESSION_ID !== "undefined") ||
      (process.env.ZCODE && process.env.ZCODE !== "undefined") ||
      (process.env.ZCODE_CONFIG && process.env.ZCODE_CONFIG !== "undefined")
    ) {
      return true;
    }
    if (process.env._ && path.basename(process.env._).toLowerCase().includes("zcode")) {
      return true;
    }
    if (process.title && path.basename(process.title).toLowerCase().includes("zcode")) {
      return true;
    }
    return false;
  }

  async identifyHost(workspaceRoot?: string): Promise<boolean> {
    if (this.hasActiveRuntimeContext(workspaceRoot)) {
      return true;
    }

    // Check workspace configuration markers
    if (workspaceRoot) {
      const candidates = [
        path.join(workspaceRoot, ".zcode"),
        path.join(workspaceRoot, ".zcode", "config.json"),
        path.join(workspaceRoot, "zcode.json"),
      ];
      if (candidates.some((p) => fs.existsSync(p))) {
        return true;
      }
    }

    if (!workspaceRoot) {
      const userZCodeDir = path.join(os.homedir(), ".zcode");
      if (fs.existsSync(userZCodeDir)) {
        return true;
      }

      if (this.getAppBundlePath()) {
        return true;
      }
    }

    return false;
  }

  async inspectVersion(workspaceRoot?: string): Promise<HostVersionInfo> {
    let version = process.env.ZCODE_VERSION;
    let raw: string | undefined = version;

    // Check workspace version file if present
    if (!version && workspaceRoot) {
      const versionFile = path.join(workspaceRoot, ".zcode", "version");
      if (fs.existsSync(versionFile)) {
        try {
          raw = fs.readFileSync(versionFile, "utf-8").trim();
          version = raw;
        } catch {
          // Skip
        }
      }
    }

    // Try CLI bundle --version
    if (!version) {
      const cliBundle = this.getCliBundlePath();
      if (cliBundle) {
        try {
          const { stdout } = await execFileAsync(process.execPath, [cliBundle, "--version"], {
            timeout: 3000,
          });
          const parsed = stdout.trim();
          if (parsed) {
            raw = parsed;
            version = parsed;
          }
        } catch {
          // Skip
        }
      }
    }

    // Try App Bundle Info.plist
    if (!version) {
      const app = this.getAppBundlePath();
      if (app) {
        const plistPath = path.join(app, "Contents", "Info.plist");
        if (fs.existsSync(plistPath)) {
          try {
            const content = fs.readFileSync(plistPath, "utf-8");
            const match = content.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/i);
            if (match) {
              raw = match[1].trim();
              version = raw;
            }
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

    if (
      normalized.startsWith("0.") ||
      normalized.startsWith("1.") ||
      normalized.startsWith("2.") ||
      normalized.startsWith("3.")
    ) {
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

  async inspectModels(workspaceRoot?: string): Promise<HostModel[]> {
    const models: HostModel[] = [];
    const { config: effective } = this.getEffectiveConfig(workspaceRoot);

    if (effective.provider && typeof effective.provider === "object") {
      for (const [providerKey, providerVal] of Object.entries(effective.provider)) {
        const pVal = providerVal as any;
        if (pVal && pVal.models && typeof pVal.models === "object") {
          for (const [modelKey, modelObj] of Object.entries<any>(pVal.models)) {
            const canonicalId = `${providerKey}/${modelKey}`;
            const features: string[] = ["tools", "chat"];

            if (modelObj && modelObj.reasoning && Array.isArray(modelObj.reasoning.variants)) {
              for (const v of modelObj.reasoning.variants) {
                features.push(`variant:${v}`);
              }
            } else if (modelObj && Array.isArray(modelObj.variants)) {
              for (const v of modelObj.variants) {
                features.push(`variant:${v}`);
              }
            }

            models.push({
              id: canonicalId,
              label: modelKey,
              state: "available",
              features,
              evidence: {
                kind: "host-config",
                locator: "zcode config provider",
              },
            });
          }
        }
      }
    }

    if (effective.model && typeof effective.model === "string") {
      if (!models.some((m) => m.id === effective.model)) {
        models.unshift({
          id: effective.model,
          label: effective.model,
          state: "available",
          features: ["tools", "chat"],
          evidence: {
            kind: "host-config",
            locator: "zcode config model",
          },
        });
      }
    }

    return models;
  }

  async inspectEffortValues(workspaceRoot?: string): Promise<string[]> {
    const values = new Set<string>();
    const models = await this.inspectModels(workspaceRoot);

    for (const m of models) {
      if (m.features) {
        for (const f of m.features) {
          if (f.startsWith("variant:")) {
            values.add(f.slice("variant:".length));
          }
        }
      }
    }

    const { config: effective } = this.getEffectiveConfig(workspaceRoot);
    if (effective.thoughtLevel && typeof effective.thoughtLevel === "string") {
      values.add(effective.thoughtLevel);
    }

    return Array.from(values);
  }

  async inspectReasoningOptions(workspaceRoot?: string): Promise<HostReasoningOptions> {
    const values = await this.inspectEffortValues(workspaceRoot);
    return {
      native_field: "reasoning",
      supported_values: values,
      default_value: values.includes("max") ? "max" : values[0],
    };
  }

  async inspectExecutionTopologyCapabilities(workspaceRoot?: string): Promise<TopologyCapabilities> {
    const caps = await this.inspectCapabilities(workspaceRoot);
    return {
      supports_single_session: true,
      supports_subagents: caps.capabilities.subagents.state === "available",
      supports_multi_agent: true,
      supports_parallel_execution: caps.capabilities.parallelism.state === "available",
      scopes: ["current-session", "new-session", "per-agent"],
    };
  }

  async inspectCapabilities(workspaceRoot?: string): Promise<HostCapabilities> {
    const models = await this.inspectModels(workspaceRoot);
    const effortValues = await this.inspectEffortValues(workspaceRoot);

    return {
      host_id: this.id,
      adapter_id: this.id,
      workspace: workspaceRoot,
      observed_at: new Date().toISOString(),
      platform: `${os.platform()}-${os.arch()}`,
      available_models: models,
      supported_effort_values: effortValues,
      default_effort_value: effortValues.includes("max") ? "max" : effortValues[0],
      capabilities: {
        subagents: {
          state: "available",
          evidence: {
            kind: "host-runtime",
            locator: "zcode subagent profiles",
          },
        },
        threads: {
          state: "available",
          evidence: {
            kind: "host-runtime",
            locator: "zcode session",
          },
        },
        parallelism: {
          state: "unknown",
        },
        model_selection: {
          state: "available",
          scopes: ["current-session", "new-session", "per-agent"],
          evidence: {
            kind: "host-config",
            locator: "zcode config model",
          },
        },
        reasoning: {
          state: effortValues.length > 0 ? "available" : "unknown",
          evidence: {
            kind: "host-config",
            locator: "zcode config reasoning",
          },
        },
        configuration_mutation: {
          state: "available",
          supports_native_files: true,
          supports_session_mutation: false,
          evidence: {
            kind: "host-config",
            locator: ".zcode/config.json",
          },
        },
      },
    };
  }

  async resolveReasoningPolicy(
    policy: string,
    modelId?: string,
    workspaceRoot?: string
  ): Promise<ResolvedReasoningPolicy | undefined> {
    const models = await this.inspectModels(workspaceRoot);
    const targetModel = modelId ? models.find((m) => m.id === modelId) : models[0];

    const variants: string[] = [];
    if (targetModel?.features) {
      for (const f of targetModel.features) {
        if (f.startsWith("variant:")) {
          variants.push(f.slice("variant:".length));
        }
      }
    }

    if (variants.length === 0) {
      variants.push(...(await this.inspectEffortValues(workspaceRoot)));
    }

    if (variants.length > 0) {
      const normalized = policy.toLowerCase().trim();
      let chosen: string | undefined;
      if (normalized === "highest-supported") {
        chosen = variants.includes("max") ? "max" : variants[variants.length - 1];
      } else if (normalized === "lowest-sufficient" || normalized === "lowest-supported") {
        chosen = variants[0];
      } else if (variants.includes(policy)) {
        chosen = policy;
      }
      if (chosen) {
        return {
          host_field: "reasoning",
          host_value: chosen,
        };
      }
    }

    return undefined;
  }

  async inspectCompanionRegistration(
    workspaceRoot?: string,
    scope?: "project" | "global" | "user"
  ): Promise<CompanionRegistrationStatus> {
    const workspace = workspaceRoot || process.cwd();
    const effectiveScope = scope === "global" || scope === "user" ? "user" : "project";

    if (effectiveScope === "project" && workspaceRoot) {
      const projectTarget = this.determineTargetConfigPath(workspace, "project");
      if (fs.existsSync(projectTarget)) {
        try {
          const content = fs.readFileSync(projectTarget, "utf-8");
          const parsed = JSON.parse(content);
          const serverConfig = parsed.mcp?.servers?.["agent-config"];
          if (serverConfig) {
            return {
              registered: true,
              transport: "stdio",
              scope: "project",
              locator: projectTarget,
              command: serverConfig.command,
              args: serverConfig.args,
              target_file: projectTarget,
              details: serverConfig,
            };
          }
        } catch {
          // Skip
        }
      }
    }

    const userTarget = this.determineTargetConfigPath(workspace, "user");
    if (fs.existsSync(userTarget)) {
      try {
        const content = fs.readFileSync(userTarget, "utf-8");
        const parsed = JSON.parse(content);
        const serverConfig = parsed.mcp?.servers?.["agent-config"];
        if (serverConfig) {
          return {
            registered: true,
            transport: "stdio",
            scope: "global",
            locator: userTarget,
            command: serverConfig.command,
            args: serverConfig.args,
            target_file: userTarget,
            details: serverConfig,
          };
        }
      } catch {
        // Skip
      }
    }

    const defaultTarget = this.determineTargetConfigPath(
      workspace,
      effectiveScope === "project" && workspaceRoot ? "project" : "user"
    );
    return {
      registered: false,
      scope: effectiveScope === "project" && workspaceRoot ? "project" : "global",
      locator: defaultTarget,
      target_file: defaultTarget,
    };
  }

  async previewCompanionRegistration(
    workspaceRoot?: string,
    scope?: "project" | "global" | "user"
  ): Promise<CompanionRegistrationPreview> {
    const workspace = workspaceRoot || process.cwd();
    const resolvedScope = (scope === "global" || scope === "user" || !workspaceRoot ? "user" : "project") as
      | "project"
      | "user";
    const targetFile = this.determineTargetConfigPath(workspace, resolvedScope);

    let existingContent: string | null = null;
    let configObj: Record<string, any> = {};

    if (fs.existsSync(targetFile)) {
      existingContent = await fsp.readFile(targetFile, "utf-8");
      try {
        configObj = JSON.parse(existingContent);
      } catch {
        return {
          supported: false,
          adapter_id: this.id,
          host_id: this.id,
          scope: resolvedScope === "user" ? "global" : "project",
          target_file: targetFile,
          mutation_targets: [],
          error: `ZCode configuration file at '${targetFile}' contains syntax errors. Rejecting companion registration.`,
        };
      }
    }

    const baselineHash = existingContent
      ? crypto.createHash("sha256").update(existingContent).digest("hex")
      : null;

    if (!configObj.mcp) configObj.mcp = {};
    if (!configObj.mcp.servers) configObj.mcp.servers = {};
    configObj.mcp.servers["agent-config"] = {
      type: "stdio",
      command: "agent-config",
      args: ["serve"],
    };

    const newContent = `${JSON.stringify(configObj, null, 2)}\n`;
    const diff = createUnifiedDiff(targetFile, existingContent, newContent);
    const previewId = `preview-companion-zcode-${Date.now()}`;
    const previewHash = crypto.createHash("sha256").update(newContent).digest("hex");

    return {
      supported: true,
      adapter_id: this.id,
      host_id: this.id,
      scope: resolvedScope === "user" ? "global" : "project",
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
        error: preview.error || "Cannot apply companion registration for ZCode.",
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
      message: "ZCode companion registration applied successfully.",
    };
  }

  async validateCompanionRegistration(workspaceRoot?: string): Promise<ValidationResult> {
    const status = await this.inspectCompanionRegistration(workspaceRoot);
    return {
      valid: status.registered,
      workspace: workspaceRoot,
      message: status.registered
        ? "ZCode companion MCP server registration validated successfully."
        : "ZCode companion MCP server is not registered.",
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
    workspaceRoot?: string,
    targetLayer?: "project" | "user"
  ): Promise<RenderedConfiguration> {
    const workspace = workspaceRoot || process.cwd();
    const effectiveLayer = targetLayer || (workspaceRoot ? "project" : "user");
    const targetFile = this.determineTargetConfigPath(workspace, effectiveLayer);

    const targetModel =
      plan.execution?.model ||
      plan.controller?.model ||
      profile?.single_model?.model;

    if (!targetModel) {
      throw new Error("Execution plan or profile does not specify a model for execution.");
    }

    let existingContent: string | null = null;
    let configObj: Record<string, any> = {};

    if (fs.existsSync(targetFile)) {
      existingContent = await fsp.readFile(targetFile, "utf-8");
      try {
        configObj = JSON.parse(existingContent);
      } catch {
        throw new Error(
          `ZCode configuration file at '${targetFile}' contains syntax errors. Rejecting mutation to prevent loss.`
        );
      }
    }

    configObj.model = targetModel;

    const targetEffort =
      extractReasoningPolicy(plan.execution) ||
      extractReasoningPolicy(plan.controller);

    if (targetEffort) {
      const resolvedPolicy = await this.resolveReasoningPolicy(targetEffort, targetModel, workspace);
      if (resolvedPolicy) {
        configObj.thoughtLevel = resolvedPolicy.host_value;
      }
    }

    const newContent = `${JSON.stringify(configObj, null, 2)}\n`;
    const diff = createUnifiedDiff(targetFile, existingContent, newContent);
    const previewId = `preview-zcode-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const files: RenderedFile[] = [
      {
        path: targetFile,
        content: newContent,
      },
    ];

    return {
      preview_id: previewId,
      mutation_targets: [targetFile],
      diff,
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
      message: `ZCode configuration applied successfully to ${appliedTargets.length} file(s).`,
    };
  }

  async validateConfiguration(
    expected: ExecutionConfig,
    workspaceRoot?: string
  ): Promise<ValidationResult> {
    const workspace = workspaceRoot || process.cwd();
    const { config: effective, sources } = this.getEffectiveConfig(workspace);

    if (sources.length === 0) {
      return {
        valid: false,
        workspace,
        message: `ZCode configuration file does not exist in workspace '${workspace}'.`,
        errors: [`Missing configuration file in ${workspace}`],
      };
    }

    const errors: string[] = [];
    const expectedModel = expected.execution?.model || expected.controller?.model;
    if (expectedModel && effective.model !== expectedModel) {
      errors.push(`Main model mismatch: expected '${expectedModel}' but actual is '${effective.model}'`);
    }

    const valid = errors.length === 0;
    return {
      valid,
      workspace,
      message: valid
        ? "ZCode host configuration matches expected execution plan."
        : `ZCode configuration drift detected: ${errors.join("; ")}`,
      errors: valid ? undefined : errors,
    };
  }

  getEffectiveConfig(workspaceRoot?: string): {
    config: any;
    sources: Array<{ path: string; config: any }>;
  } {
    const paths = this.getEffectiveConfigPaths(workspaceRoot);
    let effective: any = {};
    const sources: Array<{ path: string; config: any }> = [];

    for (const configPath of paths) {
      if (fs.existsSync(configPath)) {
        try {
          const content = fs.readFileSync(configPath, "utf-8");
          const parsed = JSON.parse(content);
          sources.push({ path: configPath, config: parsed });
          effective = this.mergeConfigLayer(effective, parsed);
        } catch {
          // Skip malformed
        }
      }
    }

    return { config: effective, sources };
  }

  private mergeConfigLayer(base: any, override: any): any {
    if (!override || typeof override !== "object") return base;
    const result = { ...base };

    for (const [k, v] of Object.entries(override)) {
      if (v && typeof v === "object" && !Array.isArray(v) && result[k] && typeof result[k] === "object") {
        result[k] = { ...result[k], ...v };
      } else {
        result[k] = v;
      }
    }

    return result;
  }

  getEffectiveConfigPaths(workspaceRoot?: string): string[] {
    const paths: string[] = [];
    const userConfig = path.join(os.homedir(), ".zcode", "cli", "config.json");
    if (fs.existsSync(userConfig)) paths.push(userConfig);

    const userV2Config = path.join(os.homedir(), ".zcode", "v2", "config.json");
    if (fs.existsSync(userV2Config)) paths.push(userV2Config);

    if (workspaceRoot) {
      const workspaceDotZCode = path.join(workspaceRoot, ".zcode", "config.json");
      if (fs.existsSync(workspaceDotZCode)) paths.push(workspaceDotZCode);

      const workspaceZCodeJson = path.join(workspaceRoot, "zcode.json");
      if (fs.existsSync(workspaceZCodeJson)) paths.push(workspaceZCodeJson);
    }

    return paths;
  }

  determineTargetConfigPath(
    workspaceRoot?: string,
    targetLayer: "project" | "user" = "project"
  ): string {
    if (targetLayer === "user" || !workspaceRoot) {
      return path.join(os.homedir(), ".zcode", "cli", "config.json");
    }

    const dotConfig = path.join(workspaceRoot, ".zcode", "config.json");
    if (fs.existsSync(dotConfig)) return dotConfig;

    const rootConfig = path.join(workspaceRoot, "zcode.json");
    if (fs.existsSync(rootConfig)) return rootConfig;

    return dotConfig;
  }
}
