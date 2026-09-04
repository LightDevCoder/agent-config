import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import * as jsonc from "jsonc-parser";
import {
  HostAdapter,
  HostCapabilities,
  HostModel,
  RenderedConfiguration,
  RenderedFile,
  ApplyResult,
  ValidationResult,
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

  async identifyHost(workspaceRoot?: string): Promise<boolean> {
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

    if (
      process.env.OPENCODE_SESSION_ID ||
      process.env.OPENCODE ||
      process.env.OPENCODE_CONFIG
    ) {
      return true;
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

  async inspectCapabilities(workspaceRoot?: string): Promise<HostCapabilities> {
    const models = await this.inspectModels(workspaceRoot);
    const effortValues = await this.inspectEffortValues(workspaceRoot);

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

    return {
      host_id: "opencode",
      adapter_id: "opencode",
      workspace: workspaceRoot,
      observed_at: new Date().toISOString(),
      platform: `${os.platform()}-${os.arch()}`,
      available_models: models,
      supported_effort_values: combinedEffortValues.length > 0 ? combinedEffortValues : effortValues,
      default_effort_value: combinedEffortValues.includes("high") ? "high" : combinedEffortValues[0] || "default",
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
          state: "available",
          evidence: {
            kind: "host-runtime",
            locator: "concurrent subagents",
          },
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
          state: "available",
          max_concurrency: 4,
          evidence: {
            kind: "host-runtime",
            locator: "subagent runner limit",
          },
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
      },
    };
  }

  async inspectModels(workspaceRoot?: string): Promise<HostModel[]> {
    const models: HostModel[] = [];
    const configLayers = this.getEffectiveConfigPaths(workspaceRoot);

    for (const configPath of configLayers) {
      if (fs.existsSync(configPath)) {
        try {
          const content = fs.readFileSync(configPath, "utf-8");
          const parsed = this.parseJsonc(content);

          // 1. Extract models defined in provider dictionary
          if (parsed.provider && typeof parsed.provider === "object") {
            for (const [providerKey, providerVal] of Object.entries(parsed.provider)) {
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

                  if (!models.some((m) => m.id === canonicalId)) {
                    models.push({
                      id: canonicalId,
                      label: modelKey,
                      state: "available",
                      features,
                      evidence: {
                        kind: "host-config",
                        locator: configPath,
                      },
                    });
                  }
                }
              }
            }
          }

          // 2. Extract current selected model if specified and not already in list
          if (parsed.model && typeof parsed.model === "string") {
            if (!models.some((m) => m.id === parsed.model)) {
              models.unshift({
                id: parsed.model,
                label: parsed.model,
                state: "available",
                features: ["tools", "chat"],
                evidence: {
                  kind: "host-config",
                  locator: configPath,
                },
              });
            }
          }
        } catch {
          // If a file is malformed, skip it during inspection
        }
      }
    }

    return models;
  }

  async inspectEffortValues(workspaceRoot?: string): Promise<string[]> {
    const values = new Set<string>(["low", "medium", "high"]);
    const configLayers = this.getEffectiveConfigPaths(workspaceRoot);

    for (const configPath of configLayers) {
      if (fs.existsSync(configPath)) {
        try {
          const content = fs.readFileSync(configPath, "utf-8");
          const parsed = this.parseJsonc(content);
          if (parsed.provider && typeof parsed.provider === "object") {
            for (const providerVal of Object.values<any>(parsed.provider)) {
              if (providerVal?.models && typeof providerVal.models === "object") {
                for (const mObj of Object.values<any>(providerVal.models)) {
                  if (Array.isArray(mObj?.variants)) {
                    for (const v of mObj.variants) values.add(String(v));
                  } else if (mObj?.variants && typeof mObj.variants === "object") {
                    for (const v of Object.keys(mObj.variants)) values.add(v);
                  }
                }
              }
            }
          }
        } catch {
          // Skip
        }
      }
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

    // Default effort mapping if no specific variants listed
    if (requestedEffortOrPolicy === "highest-supported") return "high";
    if (requestedEffortOrPolicy === "lowest-sufficient" || requestedEffortOrPolicy === "lowest-supported") return "low";
    return requestedEffortOrPolicy;
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
      profile?.single_model?.model ||
      "default";

    const targetEffort =
      plan.execution?.effort ||
      plan.controller?.effort ||
      (profile?.single_model?.execution_effort && "value" in profile.single_model.execution_effort
        ? profile.single_model.execution_effort.value
        : profile?.single_model?.execution_effort && "policy" in profile.single_model.execution_effort
        ? profile.single_model.execution_effort.policy
        : "high");

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
    const targetFile = this.resolveConfigFilePath(workspace);

    if (!targetFile || !fs.existsSync(targetFile)) {
      return {
        valid: false,
        workspace,
        message: `OpenCode configuration file does not exist in workspace '${workspace}'.`,
        errors: [`Missing configuration file in ${workspace}`],
      };
    }

    let parsed: any;
    try {
      const content = await fsp.readFile(targetFile, "utf-8");
      parsed = this.parseJsonc(content);
    } catch (err: any) {
      return {
        valid: false,
        workspace,
        message: `Failed to parse OpenCode configuration file: ${err.message}`,
        errors: [err.message],
      };
    }

    const expectedModel = expected.execution?.model || expected.controller?.model;
    const errors: string[] = [];

    if (expectedModel && parsed.model !== expectedModel) {
      errors.push(
        `Model mismatch: expected '${expectedModel}' but actual configuration has '${parsed.model}'`
      );
    }

    if (expected.work_items) {
      for (const item of expected.work_items) {
        const agentConfig = parsed.agent?.[item.ticket_id];
        if (!agentConfig) {
          errors.push(`Missing agent config for work item '${item.ticket_id}'`);
        } else {
          if (agentConfig.model !== item.model) {
            errors.push(
              `Agent '${item.ticket_id}' model mismatch: expected '${item.model}', actual '${agentConfig.model}'`
            );
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

  determineTargetConfigPath(workspaceRoot: string): string {
    const localJsonc = path.join(workspaceRoot, "opencode.jsonc");
    if (fs.existsSync(localJsonc)) return localJsonc;

    const dotJsonc = path.join(workspaceRoot, ".opencode", "opencode.jsonc");
    if (fs.existsSync(dotJsonc)) return dotJsonc;

    const dotJson = path.join(workspaceRoot, ".opencode", "opencode.json");
    if (fs.existsSync(dotJson)) return dotJson;

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
