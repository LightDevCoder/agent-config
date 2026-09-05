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
 * OpenCode host adapter implementing authentic configuration inspection (JSON/JSONC),
 * provider/model enumeration, variant discovery, config layering, apply, and validation.
 */
export class OpenCodeAdapter implements HostAdapter {
  readonly id = "opencode";
  readonly name = "OpenCode Adapter";

  hasActiveRuntimeContext(_workspaceRoot?: string): boolean {
    if (
      (process.env.OPENCODE_SESSION_ID && process.env.OPENCODE_SESSION_ID !== "undefined") ||
      (process.env.OPENCODE && process.env.OPENCODE !== "undefined") ||
      (process.env.OPENCODE_CONFIG && process.env.OPENCODE_CONFIG !== "undefined")
    ) {
      return true;
    }
    if (process.env.OPENCODE_CONFIG_DIR && fs.existsSync(process.env.OPENCODE_CONFIG_DIR)) {
      return true;
    }
    if (process.env._ && path.basename(process.env._).toLowerCase().includes("opencode")) {
      return true;
    }
    if (process.title && path.basename(process.title).toLowerCase().includes("opencode")) {
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
        path.join(workspaceRoot, "opencode.json"),
        path.join(workspaceRoot, "opencode.jsonc"),
        path.join(workspaceRoot, ".opencode"),
        path.join(workspaceRoot, ".opencode", "opencode.json"),
        path.join(workspaceRoot, ".opencode", "opencode.jsonc"),
      ];
      if (candidates.some((p) => fs.existsSync(p))) {
        return true;
      }
    }

    if (process.env.OPENCODE_CONFIG_DIR && fs.existsSync(process.env.OPENCODE_CONFIG_DIR)) {
      return true;
    }

    if (!workspaceRoot) {
      const globalConfigPath = this.getGlobalConfigPath();
      return !!globalConfigPath && fs.existsSync(globalConfigPath);
    }

    return false;
  }

  async inspectVersion(workspaceRoot?: string): Promise<HostVersionInfo> {
    let version = process.env.OPENCODE_VERSION;
    let raw: string | undefined = version;

    if (!version && workspaceRoot) {
      const versionFile = path.join(workspaceRoot, ".opencode", "version");
      if (fs.existsSync(versionFile)) {
        try {
          raw = fs.readFileSync(versionFile, "utf-8").trim();
          version = raw;
        } catch {
          // Skip
        }
      }
    }

    if (!version) {
      const globalConfig = this.getGlobalConfigPath();
      if (globalConfig) {
        const versionFile = path.join(path.dirname(globalConfig), "version");
        if (fs.existsSync(versionFile)) {
          try {
            raw = fs.readFileSync(versionFile, "utf-8").trim();
            version = raw;
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

  async inspectCapabilities(workspaceRoot?: string): Promise<HostCapabilities> {
    const models = await this.inspectModels(workspaceRoot);
    const effortValues = await this.inspectEffortValues(workspaceRoot);
    const { config: effective } = this.getEffectiveConfig(workspaceRoot);

    // Collect all variants across models for effort/variant capability
    const allVariants = new Set<string>(effortValues);
    for (const m of models) {
      if (m.features) {
        for (const f of m.features) {
          if (f.startsWith("variant:")) {
            allVariants.add(f.slice("variant:".length));
          }
        }
      }
    }
    const combinedEffortValues = Array.from(allVariants);

    // Concurrency: derive strictly from host config or environment, never default to 4
    let concurrencyLimit: number | undefined;
    let concurrencyLocator: string | undefined;

    if (typeof effective.max_concurrency === "number" && effective.max_concurrency > 0) {
      concurrencyLimit = effective.max_concurrency;
      concurrencyLocator = "opencode config max_concurrency";
    } else if (typeof effective.concurrency === "number" && effective.concurrency > 0) {
      concurrencyLimit = effective.concurrency;
      concurrencyLocator = "opencode config concurrency";
    }

    if (!concurrencyLimit && process.env.OPENCODE_MAX_CONCURRENCY) {
      const parsed = parseInt(process.env.OPENCODE_MAX_CONCURRENCY, 10);
      if (!isNaN(parsed) && parsed > 0) {
        concurrencyLimit = parsed;
        concurrencyLocator = "OPENCODE_MAX_CONCURRENCY environment variable";
      }
    }

    const concurrencyState: "available" | "unknown" = concurrencyLimit ? "available" : "unknown";
    const parallelismState: "available" | "unknown" = concurrencyLimit ? "available" : "unknown";
    const reasoningState: "available" | "unknown" = combinedEffortValues.length > 0 ? "available" : "unknown";

    return {
      host_id: "opencode",
      adapter_id: "opencode",
      workspace: workspaceRoot,
      observed_at: new Date().toISOString(),
      platform: `${os.platform()}-${os.arch()}`,
      available_models: models,
      supported_effort_values: combinedEffortValues,
      default_effort_value: combinedEffortValues.length > 0
        ? (combinedEffortValues.includes("high") ? "high" : combinedEffortValues[0])
        : undefined,
      capabilities: {
        subagents: {
          state: "available",
          evidence: {
            kind: "host-config",
            locator: "opencode.json agent",
          },
        },
        threads: {
          state: "available",
          evidence: {
            kind: "host-runtime",
            locator: "opencode session",
          },
        },
        parallelism: {
          state: parallelismState,
          ...(parallelismState === "available"
            ? {
                evidence: {
                  kind: "host-runtime",
                  locator: concurrencyLocator || "concurrent subagents",
                },
              }
            : {}),
        },
        model_selection: {
          state: "available",
          scopes: ["current-session", "new-session", "per-agent"],
          evidence: {
            kind: "host-config",
            locator: "opencode.json model",
          },
        },
        per_agent_model_selection: {
          state: "available",
          evidence: {
            kind: "host-config",
            locator: "opencode.json agent.<name>.model",
          },
        },
        concurrency: {
          state: concurrencyState,
          max_concurrency: concurrencyLimit,
          ...(concurrencyState === "available"
            ? {
                evidence: {
                  kind: "host-config",
                  locator: concurrencyLocator || "opencode concurrency setting",
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
            locator: "opencode.json",
          },
        },
        reasoning: {
          state: reasoningState,
          ...(reasoningState === "available"
            ? {
                evidence: {
                  kind: "host-config",
                  locator: "opencode provider variants",
                },
              }
            : {}),
        },
      },
    };
  }

  async inspectModels(workspaceRoot?: string): Promise<HostModel[]> {
    const models: HostModel[] = [];
    const { config: effective, modelLocators } = this.getEffectiveConfig(workspaceRoot);

    // 1. Extract models defined in provider dictionary
    if (effective.provider && typeof effective.provider === "object") {
      for (const [providerKey, providerVal] of Object.entries(effective.provider)) {
        const pVal = providerVal as any;
        if (pVal && pVal.models && typeof pVal.models === "object") {
          for (const [modelKey, modelObj] of Object.entries<any>(pVal.models)) {
            const canonicalId = `${providerKey}/${modelKey}`;
            const features: string[] = ["tools", "chat"];

            // Check for model-specific variants
            if (modelObj && Array.isArray(modelObj.variants)) {
              for (const v of modelObj.variants) {
                features.push(`variant:${v}`);
              }
            } else if (modelObj && typeof modelObj.variants === "object") {
              for (const v of Object.keys(modelObj.variants)) {
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
                locator: modelLocators.get(canonicalId) || "opencode.json provider",
              },
            });
          }
        }
      }
    }

    // 2. Also check providers plural if models array is used
    if (effective.providers && typeof effective.providers === "object") {
      for (const [providerKey, providerVal] of Object.entries<any>(effective.providers)) {
        if (providerVal && Array.isArray(providerVal.models)) {
          for (const mId of providerVal.models) {
            const canonicalId = typeof mId === "string" ? `${providerKey}/${mId}` : mId?.id;
            if (canonicalId && !models.some((m) => m.id === canonicalId)) {
              models.push({
                id: canonicalId,
                label: typeof mId === "string" ? mId : mId?.id,
                state: "available",
                features: ["tools", "chat"],
                evidence: {
                  kind: "host-config",
                  locator: modelLocators.get(canonicalId) || "opencode.json providers",
                },
              });
            }
          }
        }
      }
    }

    // 3. Extract current selected model if specified and not already in list
    if (effective.model && typeof effective.model === "string") {
      if (!models.some((m) => m.id === effective.model)) {
        models.unshift({
          id: effective.model,
          label: effective.model,
          state: "available",
          features: ["tools", "chat"],
          evidence: {
            kind: "host-config",
            locator: modelLocators.get(effective.model) || "opencode.json model",
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
    if (effective.variant && typeof effective.variant === "string") {
      values.add(effective.variant);
    }

    return Array.from(values);
  }

  /**
   * Resolves the appropriate variant for a given model and policy/effort.
   */
  resolveVariantForModel(
    modelId: string,
    requestedEffortOrPolicy: string | undefined,
    availableModels: HostModel[]
  ): string | undefined {
    if (!requestedEffortOrPolicy) return undefined;

    const modelInfo = availableModels.find((m) => m.id === modelId);
    const variants: string[] = [];
    if (modelInfo?.features) {
      for (const f of modelInfo.features) {
        if (f.startsWith("variant:")) {
          variants.push(f.slice("variant:".length));
        }
      }
    }

    // If model has explicit variants
    if (variants.length > 0) {
      if (requestedEffortOrPolicy === "highest-supported") {
        if (variants.includes("max")) return "max";
        return variants[variants.length - 1];
      }
      if (requestedEffortOrPolicy === "lowest-sufficient" || requestedEffortOrPolicy === "lowest-supported") {
        return variants[0];
      }
      if (variants.includes(requestedEffortOrPolicy)) {
        return requestedEffortOrPolicy;
      }
      return variants[variants.length - 1];
    }

    // When variants are absent from host evidence, never synthesize or resolve to "high"
    return undefined;
  }

  async inspectReasoningOptions(
    workspaceRoot?: string
  ): Promise<HostReasoningOptions> {
    const values = await this.inspectEffortValues(workspaceRoot);
    return {
      native_field: "variant",
      supported_values: values,
      default_value: values.length > 0 ? values[0] : undefined,
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
    scope?: "project" | "global"
  ): Promise<CompanionRegistrationStatus> {
    const workspace = workspaceRoot || process.cwd();

    // Check project config if requested or workspaceRoot available
    if (scope !== "global" && workspaceRoot) {
      const projectTarget = this.determineTargetConfigPath(workspace, "project");
      if (fs.existsSync(projectTarget)) {
        try {
          const content = fs.readFileSync(projectTarget, "utf-8");
          const parsed = this.parseJsonc(content);
          const serverConfig =
            parsed.mcp?.servers?.["agent-config"] ||
            parsed.mcp?.["agent-config"];
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
          // Skip parse error
        }
      }
    }

    // Check global config
    if (scope !== "project") {
      const globalTarget = this.determineTargetConfigPath(workspace, "global");
      if (fs.existsSync(globalTarget)) {
        try {
          const content = fs.readFileSync(globalTarget, "utf-8");
          const parsed = this.parseJsonc(content);
          const serverConfig =
            parsed.mcp?.servers?.["agent-config"] ||
            parsed.mcp?.["agent-config"];
          if (serverConfig) {
            return {
              registered: true,
              transport: "stdio",
              scope: "global",
              locator: globalTarget,
              command: serverConfig.command,
              args: serverConfig.args,
              target_file: globalTarget,
              details: serverConfig,
            };
          }
        } catch {
          // Skip parse error
        }
      }
    }

    const defaultTarget = this.determineTargetConfigPath(
      workspace,
      scope || (workspaceRoot ? "project" : "global")
    );
    const resolvedScope = (scope || (workspaceRoot ? "project" : "global")) as "project" | "global";
    return {
      registered: false,
      scope: resolvedScope,
      locator: defaultTarget,
      target_file: defaultTarget,
    };
  }

  async previewCompanionRegistration(
    workspaceRoot?: string,
    scope?: "project" | "global"
  ): Promise<CompanionRegistrationPreview> {
    const workspace = workspaceRoot || process.cwd();
    const resolvedScope = (scope || (workspaceRoot ? "project" : "global")) as "project" | "global";
    const targetFile = this.determineTargetConfigPath(
      workspace,
      resolvedScope
    );

    let existingContent: string | null = null;
    let initialText = "{\n  \"$schema\": \"https://opencode.ai/config.json\"\n}\n";

    if (fs.existsSync(targetFile)) {
      existingContent = await fsp.readFile(targetFile, "utf-8");
      try {
        this.parseJsonc(existingContent);
        initialText = existingContent;
      } catch {
        return {
          supported: false,
          adapter_id: this.id,
          host_id: this.id,
          scope: resolvedScope,
          target_file: targetFile,
          mutation_targets: [],
          error: `OpenCode configuration file at '${targetFile}' contains syntax errors. Rejecting companion registration to prevent loss.`,
        };
      }
    }

    const baselineHash = existingContent
      ? crypto.createHash("sha256").update(existingContent).digest("hex")
      : null;

    const formatting = { formattingOptions: { insertSpaces: true, tabSize: 2 } };
    const edits = jsonc.modify(
      initialText,
      ["mcp", "servers", "agent-config"],
      { command: "agent-config", args: ["serve"] },
      formatting
    );
    const newContent = jsonc.applyEdits(initialText, edits);

    const diff = createUnifiedDiff(targetFile, existingContent, newContent);
    const previewId = `preview-companion-opencode-${Date.now()}`;
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
        error: preview.error || "Cannot apply companion registration for OpenCode.",
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
      message: "OpenCode companion registration applied successfully.",
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
        ? "OpenCode companion MCP server registration validated successfully."
        : "OpenCode companion MCP server is not registered.",
    };
  }

  async previewConfiguration(
    plan: ExecutionConfig,
    profile?: AgentProfile,
    workspaceRoot?: string
  ): Promise<RenderedConfiguration> {
    return this.renderConfiguration(plan, profile, workspaceRoot);
  }

  async resolveReasoningPolicy(
    policy: string,
    modelId?: string,
    workspaceRoot?: string
  ): Promise<ResolvedReasoningPolicy | undefined> {
    const models = await this.inspectModels(workspaceRoot);
    const targetModelId = modelId || models[0]?.id;

    if (targetModelId) {
      const variant = this.resolveVariantForModel(targetModelId, policy, models);
      if (variant) {
        return {
          host_field: "variant",
          host_value: variant,
        };
      }
    }

    const effortValues = await this.inspectEffortValues(workspaceRoot);
    if (effortValues.length > 0) {
      const normalized = policy.toLowerCase().trim();
      let chosen: string | undefined;
      if (normalized === "highest-supported") {
        chosen = effortValues.includes("max") ? "max" : effortValues[effortValues.length - 1];
      } else if (normalized === "lowest-sufficient" || normalized === "lowest-supported") {
        chosen = effortValues[0];
      } else if (normalized === "configured") {
        chosen = effortValues[0];
      } else if (effortValues.includes(policy)) {
        chosen = policy;
      }
      if (chosen) {
        return {
          host_field: "variant",
          host_value: chosen,
        };
      }
    }

    return undefined;
  }

  async renderConfiguration(
    plan: ExecutionConfig,
    profile?: AgentProfile,
    workspaceRoot?: string,
    targetLayer?: "project" | "global"
  ): Promise<RenderedConfiguration> {
    const workspace = workspaceRoot || process.cwd();
    const effectiveLayer = targetLayer || (plan as any).target_layer || (workspaceRoot ? "project" : "global");
    const targetFile = this.determineTargetConfigPath(workspace, effectiveLayer);

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
    let initialText = "{\n  \"$schema\": \"https://opencode.ai/config.json\"\n}\n";

    if (fs.existsSync(targetFile)) {
      existingContent = await fsp.readFile(targetFile, "utf-8");
      // Fail closed: parse strictly with jsonc-parser. If invalid, throw clear error.
      const parseErrors: jsonc.ParseError[] = [];
      jsonc.parse(existingContent, parseErrors, { allowTrailingComma: true });
      if (parseErrors.length > 0) {
        throw new Error(
          `OpenCode configuration file at '${targetFile}' contains syntax errors. Rejecting mutation to prevent configuration loss.`
        );
      }
      initialText = existingContent;
    }

    const availableModels = await this.inspectModels(workspace);

    // Apply minimal edits using jsonc.modify to preserve comments, formatting, and unrelated keys
    const formatting = { formattingOptions: { insertSpaces: true, tabSize: 2 } };
    let currentText = initialText;

    // 1. Update model
    const modelEdits = jsonc.modify(currentText, ["model"], targetModel, formatting);
    currentText = jsonc.applyEdits(currentText, modelEdits);

    // 2. If single-pass has variant/effort
    const mainVariant = this.resolveVariantForModel(targetModel, targetEffort, availableModels);
    if (mainVariant && mainVariant !== "default") {
      const variantEdits = jsonc.modify(currentText, ["variant"], mainVariant, formatting);
      currentText = jsonc.applyEdits(currentText, variantEdits);
    }

    // 3. If decomposed with work_items, configure agents with model and variant
    if (plan.work_items && plan.work_items.length > 0) {
      for (const item of plan.work_items) {
        const itemVariant = this.resolveVariantForModel(
          item.model,
          item.effort_policy || item.effort,
          availableModels
        );

        const agentPatch: Record<string, any> = {
          model: item.model,
        };
        if (itemVariant && itemVariant !== "default") {
          agentPatch.variant = itemVariant;
        }

        const agentEdits = jsonc.modify(
          currentText,
          ["agent", item.ticket_id],
          agentPatch,
          formatting
        );
        currentText = jsonc.applyEdits(currentText, agentEdits);
      }
    }

    const diff = createUnifiedDiff(targetFile, existingContent, currentText);

    const files: RenderedFile[] = [
      {
        path: targetFile,
        content: currentText,
      },
    ];

    const previewId = `preview-opencode-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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
      message: `OpenCode configuration applied successfully to ${appliedTargets.length} file(s).`,
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
        message: `OpenCode configuration file does not exist in workspace '${workspace}'.`,
        errors: [`Missing configuration file in ${workspace}`],
      };
    }

    const errors: string[] = [];
    const availableModels = await this.inspectModels(workspace);

    // 1. Validate Main Model (§75)
    const expectedModel = expected.execution?.model || expected.controller?.model;
    if (expectedModel && effective.model !== expectedModel) {
      errors.push(
        `Main model mismatch: expected '${expectedModel}' but actual configuration has '${effective.model}'`
      );
    }

    // 2. Validate Main Variant (§75)
    const expectedEffort =
      expected.execution?.effort ||
      expected.execution?.effort_policy ||
      expected.controller?.effort ||
      expected.controller?.effort_policy;

    if (expectedEffort) {
      const resolvedMainVariant =
        this.resolveVariantForModel(expectedModel || effective.model || "", expectedEffort, availableModels);

      if (resolvedMainVariant && resolvedMainVariant !== "default") {
        if (effective.variant !== resolvedMainVariant) {
          errors.push(
            `Main variant mismatch: expected '${resolvedMainVariant}' but actual configuration has '${effective.variant}'`
          );
        }
      } else if (effective.variant && !resolvedMainVariant) {
        if (effective.variant !== expectedEffort) {
          errors.push(
            `Main variant mismatch: expected '${expectedEffort}' but actual configuration has '${effective.variant}'`
          );
        }
      }
    }

    // 3. Validate Worker Model & Worker Variant (§75)
    if (expected.work_items && expected.work_items.length > 0) {
      for (const item of expected.work_items) {
        const agentConfig = effective.agent?.[item.ticket_id];
        if (!agentConfig) {
          errors.push(`Missing agent config for work item '${item.ticket_id}'`);
        } else {
          // Worker Model
          if (agentConfig.model !== item.model) {
            errors.push(
              `Agent '${item.ticket_id}' model mismatch: expected '${item.model}', actual '${agentConfig.model}'`
            );
          }

          // Worker Variant
          const itemEffort = item.effort || item.effort_policy;
          if (itemEffort) {
            const resolvedWorkerVariant =
              this.resolveVariantForModel(item.model, itemEffort, availableModels);

            if (resolvedWorkerVariant && resolvedWorkerVariant !== "default") {
              if (agentConfig.variant !== resolvedWorkerVariant) {
                errors.push(
                  `Agent '${item.ticket_id}' variant mismatch: expected '${resolvedWorkerVariant}', actual '${agentConfig.variant}'`
                );
              }
            } else if (agentConfig.variant && !resolvedWorkerVariant) {
              if (agentConfig.variant !== itemEffort) {
                errors.push(
                  `Agent '${item.ticket_id}' variant mismatch: expected '${itemEffort}', actual '${agentConfig.variant}'`
                );
              }
            }
          }
        }
      }
    }

    const valid = errors.length === 0;
    return {
      valid,
      workspace,
      message: valid
        ? "OpenCode host configuration matches expected execution plan."
        : `OpenCode configuration drift detected: ${errors.join("; ")}`,
      errors: valid ? undefined : errors,
    };
  }

  getEffectiveConfig(workspaceRoot?: string): {
    config: any;
    modelLocators: Map<string, string>;
    sources: Array<{ path: string; config: any }>;
  } {
    const paths = this.getEffectiveConfigPaths(workspaceRoot);
    let effective: any = {};
    const modelLocators = new Map<string, string>();
    const sources: Array<{ path: string; config: any }> = [];

    for (const configPath of paths) {
      if (fs.existsSync(configPath)) {
        try {
          const content = fs.readFileSync(configPath, "utf-8");
          const parsed = this.parseJsonc(content);
          sources.push({ path: configPath, config: parsed });
          effective = this.mergeConfigLayer(effective, parsed, configPath, modelLocators);
        } catch {
          // Skip malformed during inspection
        }
      }
    }

    return { config: effective, modelLocators, sources };
  }

  private mergeConfigLayer(
    base: any,
    override: any,
    sourcePath: string,
    modelLocators: Map<string, string>
  ): any {
    if (!override || typeof override !== "object") return base;

    const result = { ...base };

    // Scalar fields: project overrides global
    if (override.model !== undefined) {
      result.model = override.model;
      modelLocators.set(override.model, sourcePath);
    }
    if (override.variant !== undefined) {
      result.variant = override.variant;
    }
    if (override.max_concurrency !== undefined) {
      result.max_concurrency = override.max_concurrency;
    }
    if (override.concurrency !== undefined) {
      result.concurrency = override.concurrency;
    }
    if (override.theme !== undefined) {
      result.theme = override.theme;
    }

    // Provider dictionary: deep merge providers and models
    if (override.provider && typeof override.provider === "object") {
      result.provider = result.provider ? { ...result.provider } : {};
      for (const [providerKey, providerVal] of Object.entries(override.provider)) {
        if (!providerVal || typeof providerVal !== "object") {
          result.provider[providerKey] = providerVal;
          continue;
        }
        const baseProv =
          result.provider[providerKey] && typeof result.provider[providerKey] === "object"
            ? { ...result.provider[providerKey] }
            : {};
        const overrideProv = providerVal as any;
        const mergedProv = { ...baseProv, ...overrideProv };

        if (overrideProv.models && typeof overrideProv.models === "object") {
          mergedProv.models = baseProv.models ? { ...baseProv.models } : {};
          for (const [modelKey, modelVal] of Object.entries(overrideProv.models)) {
            const canonicalId = `${providerKey}/${modelKey}`;
            modelLocators.set(canonicalId, sourcePath);

            if (modelVal && typeof modelVal === "object") {
              const baseModel = mergedProv.models[modelKey] || {};
              const mergedModel = { ...baseModel, ...modelVal };

              // Config Precedence (§30): Project overrides global variants (not unioned/flattened)
              if (Array.isArray((modelVal as any).variants)) {
                mergedModel.variants = [...(modelVal as any).variants];
              } else if (
                (modelVal as any).variants &&
                typeof (modelVal as any).variants === "object"
              ) {
                mergedModel.variants = { ...(modelVal as any).variants };
              }

              mergedProv.models[modelKey] = mergedModel;
            } else {
              mergedProv.models[modelKey] = modelVal;
            }
          }
        }
        result.provider[providerKey] = mergedProv;
      }
    }

    // Providers plural if used
    if (override.providers && typeof override.providers === "object") {
      result.providers = result.providers ? { ...result.providers } : {};
      for (const [providerKey, providerVal] of Object.entries(override.providers)) {
        result.providers[providerKey] = providerVal;
      }
    }

    // Agent dictionary: per-agent config override
    if (override.agent && typeof override.agent === "object") {
      result.agent = result.agent ? { ...result.agent } : {};
      for (const [agentKey, agentVal] of Object.entries(override.agent)) {
        if (agentVal && typeof agentVal === "object") {
          result.agent[agentKey] = {
            ...(result.agent[agentKey] || {}),
            ...agentVal,
          };
        } else {
          result.agent[agentKey] = agentVal;
        }
      }
    }

    // MCP: merge servers
    if (override.mcp && typeof override.mcp === "object") {
      result.mcp = result.mcp ? { ...result.mcp } : {};
      const baseServers = result.mcp.servers || {};
      const overrideServers = (override.mcp as any).servers || {};
      result.mcp = {
        ...result.mcp,
        ...override.mcp,
        servers: {
          ...baseServers,
          ...overrideServers,
        },
      };
    }

    // Non-conflicting top-level fields
    for (const [key, val] of Object.entries(override)) {
      if (!(key in result)) {
        result[key] = val;
      }
    }

    return result;
  }

  getEffectiveConfigPaths(workspaceRoot?: string): string[] {
    const paths: string[] = [];
    const globalPath = this.getGlobalConfigPath();
    if (globalPath) paths.push(globalPath);

    if (workspaceRoot) {
      const dotJsonc = path.join(workspaceRoot, ".opencode", "opencode.jsonc");
      if (fs.existsSync(dotJsonc)) paths.push(dotJsonc);
      const dotJson = path.join(workspaceRoot, ".opencode", "opencode.json");
      if (fs.existsSync(dotJson)) paths.push(dotJson);

      const localJsonc = path.join(workspaceRoot, "opencode.jsonc");
      if (fs.existsSync(localJsonc)) paths.push(localJsonc);
      const localJson = path.join(workspaceRoot, "opencode.json");
      if (fs.existsSync(localJson)) paths.push(localJson);
    }

    return paths;
  }

  private resolveConfigFilePath(workspaceRoot?: string): string | null {
    if (workspaceRoot) {
      const localJson = path.join(workspaceRoot, "opencode.json");
      if (fs.existsSync(localJson)) return localJson;

      const localJsonc = path.join(workspaceRoot, "opencode.jsonc");
      if (fs.existsSync(localJsonc)) return localJsonc;

      const dotJson = path.join(workspaceRoot, ".opencode", "opencode.json");
      if (fs.existsSync(dotJson)) return dotJson;

      const dotJsonc = path.join(workspaceRoot, ".opencode", "opencode.jsonc");
      if (fs.existsSync(dotJsonc)) return dotJsonc;
    }

    return this.getGlobalConfigPath();
  }

  determineTargetConfigPath(
    workspaceRoot?: string,
    targetLayer: "project" | "global" = "project"
  ): string {
    if (targetLayer === "global" || !workspaceRoot) {
      const globalPath = this.getGlobalConfigPath();
      if (globalPath) return globalPath;
      const configDir =
        process.env.OPENCODE_CONFIG_DIR ||
        path.join(os.homedir(), ".config", "opencode");
      return path.join(configDir, "opencode.json");
    }

    const localJsonc = path.join(workspaceRoot, "opencode.jsonc");
    if (fs.existsSync(localJsonc)) return localJsonc;

    const dotJsonc = path.join(workspaceRoot, ".opencode", "opencode.jsonc");
    if (fs.existsSync(dotJsonc)) return dotJsonc;

    const dotJson = path.join(workspaceRoot, ".opencode", "opencode.json");
    if (fs.existsSync(dotJson)) return dotJson;

    const localJson = path.join(workspaceRoot, "opencode.json");
    if (fs.existsSync(localJson)) return localJson;

    return path.join(workspaceRoot, "opencode.json");
  }

  private getGlobalConfigPath(): string | null {
    const configDir =
      process.env.OPENCODE_CONFIG_DIR ||
      path.join(os.homedir(), ".config", "opencode");

    const jsoncPath = path.join(configDir, "opencode.jsonc");
    if (fs.existsSync(jsoncPath)) return jsoncPath;

    const jsonPath = path.join(configDir, "opencode.json");
    if (fs.existsSync(jsonPath)) return jsonPath;

    return null;
  }

  parseJsonc(content: string): any {
    const errors: jsonc.ParseError[] = [];
    const parsed = jsonc.parse(content, errors, { allowTrailingComma: true });
    if (errors.length > 0) {
      throw new Error(`JSONC parse error at offset ${errors[0].offset} (code: ${errors[0].error})`);
    }
    return parsed;
  }
}
