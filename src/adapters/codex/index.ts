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
 * Codex host adapter implementing native inspection, model enumeration,
 * discrete effort values, configuration rendering (TOML), apply, and validation.
 */
export class CodexAdapter implements HostAdapter {
  readonly id = "codex";
  readonly name = "Codex Adapter";

  private defaultModels: HostModel[] = [
    {
      id: "gpt-5.6-sol",
      label: "GPT-5.6 Sol",
      state: "available",
      features: ["tools", "reasoning"],
      evidence: {
        kind: "host-config",
        locator: ".codex/config.toml",
      },
    },
    {
      id: "gpt-5.6-terra",
      label: "GPT-5.6 Terra",
      state: "available",
      features: ["tools", "reasoning"],
      evidence: {
        kind: "host-config",
        locator: ".codex/config.toml",
      },
    },
    {
      id: "gpt-5.6-luna",
      label: "GPT-5.6 Luna",
      state: "available",
      features: ["tools", "fast"],
      evidence: {
        kind: "host-config",
        locator: ".codex/config.toml",
      },
    },
    {
      id: "gpt-5.4",
      label: "GPT-5.4",
      state: "available",
      features: ["tools", "vision"],
      evidence: {
        kind: "host-config",
        locator: ".codex/config.toml",
      },
    },
    {
      id: "gpt-5.4-mini",
      label: "GPT-5.4 Mini",
      state: "available",
      features: ["tools", "fast"],
      evidence: {
        kind: "host-config",
        locator: ".codex/config.toml",
      },
    },
    {
      id: "o3-mini",
      label: "o3-mini",
      state: "available",
      features: ["tools", "reasoning"],
      evidence: {
        kind: "host-config",
        locator: ".codex/config.toml",
      },
    },
  ];

  private effortValues = ["low", "medium", "high", "max"];

  async identifyHost(workspaceRoot?: string): Promise<boolean> {
    if (workspaceRoot) {
      const workspaceCodexDir = path.join(workspaceRoot, ".codex");
      const workspaceCodexToml = path.join(workspaceRoot, "codex.toml");
      if (fs.existsSync(workspaceCodexDir) || fs.existsSync(workspaceCodexToml)) {
        return true;
      }
    }

    if (
      process.env.CODEX_THREAD_ID ||
      process.env.CODEX_SESSION_ID ||
      process.env.CODEX_WORKSPACE
    ) {
      return true;
    }

    if (process.env.CODEX_HOME && fs.existsSync(process.env.CODEX_HOME)) {
      return true;
    }

    // Only inspect global ~/.codex if not checking within an explicit workspace
    if (!workspaceRoot) {
      const codexHome = path.join(os.homedir(), ".codex");
      return fs.existsSync(codexHome);
    }

    return false;
  }

  async inspectCapabilities(workspaceRoot?: string): Promise<HostCapabilities> {
    const models = await this.inspectModels(workspaceRoot);
    const effortValues = await this.inspectEffortValues(workspaceRoot);

    return {
      host_id: "codex",
      adapter_id: "codex",
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
            kind: "host-runtime",
            locator: ".codex/agents",
          },
        },
        threads: {
          state: "available",
          evidence: {
            kind: "host-runtime",
            locator: ".codex session db",
          },
        },
        parallelism: {
          state: "available",
          evidence: {
            kind: "host-runtime",
            locator: "codex thread pool",
          },
        },
        model_selection: {
          state: "available",
          scopes: ["current-session", "new-session", "per-agent"],
          evidence: {
            kind: "host-config",
            locator: ".codex/config.toml",
          },
        },
        per_agent_model_selection: {
          state: "available",
          evidence: {
            kind: "host-config",
            locator: ".codex/agents/*.toml",
          },
        },
        concurrency: {
          state: "available",
          max_concurrency: 4,
          evidence: {
            kind: "host-runtime",
            locator: "worker limit",
          },
        },
        configuration_mutation: {
          state: "available",
          supports_native_files: true,
          supports_session_mutation: false,
          evidence: {
            kind: "host-config",
            locator: ".codex/config.toml",
          },
        },
      },
    };
  }

  async inspectModels(workspaceRoot?: string): Promise<HostModel[]> {
    const models = [...this.defaultModels];

    // Check workspace .codex/config.toml if present for configured model
    if (workspaceRoot) {
      const configPath = path.join(workspaceRoot, ".codex", "config.toml");
      if (fs.existsSync(configPath)) {
        try {
          const content = fs.readFileSync(configPath, "utf-8");
          const configuredModel = this.extractTomlString(content, "model");
          if (configuredModel && !models.some((m) => m.id === configuredModel)) {
            models.unshift({
              id: configuredModel,
              label: configuredModel,
              state: "available",
              features: ["tools"],
              evidence: {
                kind: "host-config",
                locator: configPath,
              },
            });
          }
        } catch {
          // Ignore read error and return default models
        }
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
    const codexDir = path.join(workspace, ".codex");
    const configTomlPath = path.join(codexDir, "config.toml");

    // Determine target model and effort
    const targetModel =
      plan.execution?.model ||
      plan.controller?.model ||
      profile?.single_model?.model ||
      "gpt-5.6-sol";

    const targetEffort =
      plan.execution?.effort ||
      plan.controller?.effort ||
      (profile?.single_model?.execution_effort && "value" in profile.single_model.execution_effort
        ? profile.single_model.execution_effort.value
        : "high");

    let existingContent: string | null = null;
    if (fs.existsSync(configTomlPath)) {
      existingContent = await fsp.readFile(configTomlPath, "utf-8");
    }

    let newConfigContent = existingContent || "";
    newConfigContent = this.updateTomlKeyValue(newConfigContent, "model", targetModel);
    newConfigContent = this.updateTomlKeyValue(
      newConfigContent,
      "model_reasoning_effort",
      targetEffort
    );

    const files: RenderedFile[] = [
      {
        path: configTomlPath,
        content: newConfigContent,
      },
    ];

    let combinedDiff = createUnifiedDiff(configTomlPath, existingContent, newConfigContent);

    // If decomposed task has work_items, render per-agent configuration files
    if (plan.work_items && plan.work_items.length > 0) {
      for (const item of plan.work_items) {
        const agentFilePath = path.join(codexDir, "agents", `${item.ticket_id}.toml`);
        let existingAgentContent: string | null = null;
        if (fs.existsSync(agentFilePath)) {
          existingAgentContent = await fsp.readFile(agentFilePath, "utf-8");
        }

        const newAgentContent =
          `name = "${item.ticket_id}"\n` +
          `model = "${item.model}"\n` +
          `model_reasoning_effort = "${item.effort}"\n`;

        files.push({
          path: agentFilePath,
          content: newAgentContent,
        });

        combinedDiff += "\n" + createUnifiedDiff(agentFilePath, existingAgentContent, newAgentContent);
      }
    }

    const previewId = `preview-codex-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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
      message: `Codex configuration applied successfully to ${appliedTargets.length} target(s).`,
    };
  }

  async validateConfiguration(
    expected: ExecutionConfig,
    workspaceRoot?: string
  ): Promise<ValidationResult> {
    const workspace = workspaceRoot || process.cwd();
    const configTomlPath = path.join(workspace, ".codex", "config.toml");

    if (!fs.existsSync(configTomlPath)) {
      return {
        valid: false,
        workspace,
        message: `Codex configuration file '${configTomlPath}' does not exist.`,
        errors: [`Missing configuration file: ${configTomlPath}`],
      };
    }

    const content = await fsp.readFile(configTomlPath, "utf-8");
    const actualModel = this.extractTomlString(content, "model");
    const actualEffort = this.extractTomlString(content, "model_reasoning_effort");

    const expectedModel =
      expected.execution?.model || expected.controller?.model;
    const expectedEffort =
      expected.execution?.effort || expected.controller?.effort;

    const errors: string[] = [];
    if (expectedModel && actualModel !== expectedModel) {
      errors.push(
        `Model mismatch: expected '${expectedModel}' but actual configuration has '${actualModel}'`
      );
    }

    if (expectedEffort && actualEffort !== expectedEffort) {
      errors.push(
        `Effort mismatch: expected '${expectedEffort}' but actual configuration has '${actualEffort}'`
      );
    }

    // If work items, validate agent files
    if (expected.work_items) {
      for (const item of expected.work_items) {
        const agentPath = path.join(workspace, ".codex", "agents", `${item.ticket_id}.toml`);
        if (!fs.existsSync(agentPath)) {
          errors.push(`Missing work item agent config: ${agentPath}`);
        } else {
          const agentContent = await fsp.readFile(agentPath, "utf-8");
          const agentModel = this.extractTomlString(agentContent, "model");
          if (agentModel !== item.model) {
            errors.push(
              `Agent '${item.ticket_id}' model mismatch: expected '${item.model}', actual '${agentModel}'`
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
        ? "Codex host configuration matches expected execution plan."
        : `Codex configuration drift detected: ${errors.join("; ")}`,
      errors: valid ? undefined : errors,
    };
  }

  private extractTomlString(content: string, key: string): string | null {
    const match = content.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"`, "m"));
    return match ? match[1] : null;
  }

  private updateTomlKeyValue(content: string, key: string, value: string): string {
    const lineRegex = new RegExp(`^(\\s*${key}\\s*=\\s*).*$`, "m");
    const quoted = `"${value.replace(/"/g, '\\"')}"`;
    if (lineRegex.test(content)) {
      return content.replace(lineRegex, `${key} = ${quoted}`);
    }
    const trimmed = content.trim();
    return trimmed ? `${key} = ${quoted}\n${trimmed}\n` : `${key} = ${quoted}\n`;
  }
}
