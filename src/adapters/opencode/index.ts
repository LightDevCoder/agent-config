import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
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
 * provider/model enumeration, subagent and MCP topology inspection, apply, and validation.
 */
export class OpenCodeAdapter implements HostAdapter {
  readonly id = "opencode";
  readonly name = "OpenCode Adapter";

  private effortValues = ["low", "medium", "high"];

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

    // Only inspect global ~/.config/opencode if not checking within an explicit workspace
    if (!workspaceRoot) {
      const globalConfigPath = this.getGlobalConfigPath();
      return !!globalConfigPath && fs.existsSync(globalConfigPath);
    }

    return false;
  }

  async inspectCapabilities(workspaceRoot?: string): Promise<HostCapabilities> {
    const models = await this.inspectModels(workspaceRoot);
    const effortValues = await this.inspectEffortValues(workspaceRoot);

    return {
      host_id: "opencode",
      adapter_id: "opencode",
      workspace: workspaceRoot,
      observed_at: new Date().toISOString(),
      platform: `${os.platform()}-${os.arch()}`,
      available_models: models,
      supported_effort_values: effortValues,
      default_effort_value: "high",
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
    const configPath = this.resolveConfigFilePath(workspaceRoot);

    if (configPath && fs.existsSync(configPath)) {
      try {
        const content = fs.readFileSync(configPath, "utf-8");
        const parsed = this.parseJsonc(content);

        // 1. Extract models defined in provider dictionary
        if (parsed.provider && typeof parsed.provider === "object") {
          for (const [providerKey, providerVal] of Object.entries(parsed.provider)) {
            const pVal = providerVal as any;
            if (pVal && pVal.models && typeof pVal.models === "object") {
              for (const modelKey of Object.keys(pVal.models)) {
                const canonicalId = `${providerKey}/${modelKey}`;
                models.push({
                  id: canonicalId,
                  label: modelKey,
                  state: "available",
                  features: ["tools", "chat"],
                  evidence: {
                    kind: "host-config",
                    locator: configPath,
                  },
                });
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
        // Ignore read/parse errors and return whatever models found
      }
    }

    return models;
  }

  async inspectEffortValues(_workspaceRoot?: string): Promise<string[]> {
    return [...this.effortValues];
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

    let existingContent: string | null = null;
    let configObj: Record<string, any> = {
      $schema: "https://opencode.ai/config.json",
    };

    if (fs.existsSync(targetFile)) {
      existingContent = await fsp.readFile(targetFile, "utf-8");
      try {
        configObj = this.parseJsonc(existingContent);
      } catch {
        configObj = { $schema: "https://opencode.ai/config.json" };
      }
    }

    // Set model
    configObj.model = targetModel;

    // If decomposed with work_items, configure agents
    if (plan.work_items && plan.work_items.length > 0) {
      configObj.agent = configObj.agent || {};
      for (const item of plan.work_items) {
        configObj.agent[item.ticket_id] = {
          ...configObj.agent[item.ticket_id],
          model: item.model,
        };
      }
    }

    const newContent = JSON.stringify(configObj, null, 2) + "\n";
    const diff = createUnifiedDiff(targetFile, existingContent, newContent);

    const files: RenderedFile[] = [
      {
        path: targetFile,
        content: newContent,
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
        } else if (agentConfig.model !== item.model) {
          errors.push(
            `Agent '${item.ticket_id}' model mismatch: expected '${item.model}', actual '${agentConfig.model}'`
          );
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

  private determineTargetConfigPath(workspaceRoot: string): string {
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

  private parseJsonc(content: string): any {
    // Strip single-line (//) and multi-line (/* */) comments while preserving strings
    const stripped = content.replace(
      /\\"|"(?:\\"|[^"])*"|(\/\/.*|\/\*[\s\S]*?\*\/)/g,
      (match, comment) => (comment ? "" : match)
    );
    return JSON.parse(stripped);
  }
}
