import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
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
import { rootValue, updateRootString } from "./toml.js";

/**
 * Codex host adapter implementing authentic inspection, model enumeration,
 * discrete effort values, configuration rendering (TOML), apply, and validation.
 * Strictly avoids hardcoding speculative model inventories or unverified concurrency/max effort.
 */
export class CodexAdapter implements HostAdapter {
  readonly id = "codex";
  readonly name = "Codex Adapter";

  hasActiveRuntimeContext(_workspaceRoot?: string): boolean {
    if (
      (process.env.CODEX_THREAD_ID && process.env.CODEX_THREAD_ID !== "undefined") ||
      (process.env.CODEX_SESSION_ID && process.env.CODEX_SESSION_ID !== "undefined") ||
      (process.env.CODEX_WORKSPACE && process.env.CODEX_WORKSPACE !== "undefined")
    ) {
      return true;
    }
    if (process.env._ && path.basename(process.env._).toLowerCase().includes("codex")) {
      return true;
    }
    if (process.title && path.basename(process.title).toLowerCase().includes("codex")) {
      return true;
    }
    return false;
  }

  async identifyHost(workspaceRoot?: string): Promise<boolean> {
    if (this.hasActiveRuntimeContext(workspaceRoot)) {
      return true;
    }

    if (workspaceRoot) {
      const workspaceCodexDir = path.join(workspaceRoot, ".codex");
      const workspaceCodexToml = path.join(workspaceRoot, "codex.toml");
      if (fs.existsSync(workspaceCodexDir) || fs.existsSync(workspaceCodexToml)) {
        return true;
      }
    }

    if (process.env.CODEX_HOME && fs.existsSync(process.env.CODEX_HOME)) {
      return true;
    }

    if (!workspaceRoot) {
      const codexHome = path.join(os.homedir(), ".codex");
      return fs.existsSync(codexHome);
    }

    return false;
  }

  async inspectVersion(workspaceRoot?: string): Promise<HostVersionInfo> {
    let version = process.env.CODEX_VERSION;
    let raw: string | undefined = version;

    if (!version && workspaceRoot) {
      const versionFile = path.join(workspaceRoot, ".codex", "version");
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
      const globalVersionFile = path.join(
        process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
        "version"
      );
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

    // Concurrency: derive strictly from config or environment, else state is unknown
    let concurrencyLimit: number | undefined;
    let concurrencyState: "available" | "unknown" = "unknown";
    let concurrencyLocator: string | undefined;

    const configPath = this.resolveConfigPath(workspaceRoot);
    if (configPath && fs.existsSync(configPath)) {
      try {
        const content = fs.readFileSync(configPath, "utf-8");
        const concurrencyStr = this.extractTomlValue(content, "max_concurrency");
        if (concurrencyStr && !isNaN(parseInt(concurrencyStr, 10))) {
          concurrencyLimit = parseInt(concurrencyStr, 10);
          concurrencyState = "available";
          concurrencyLocator = `${configPath} max_concurrency`;
        }
      } catch {
        // Skip
      }
    }

    if (!concurrencyLimit && process.env.CODEX_MAX_CONCURRENCY) {
      const parsed = parseInt(process.env.CODEX_MAX_CONCURRENCY, 10);
      if (!isNaN(parsed) && parsed > 0) {
        concurrencyLimit = parsed;
        concurrencyState = "available";
        concurrencyLocator = "CODEX_MAX_CONCURRENCY environment variable";
      }
    }

    const reasoningState: "available" | "unknown" = effortValues.length > 0 ? "available" : "unknown";

    // Subagents: inspect real evidence (§25)
    let subagentsState: "available" | "unknown" = "unknown";
    let subagentsLocator: string | undefined;

    if (process.env.CODEX_SUBAGENTS === "1" || process.env.CODEX_SUBAGENTS === "true") {
      subagentsState = "available";
      subagentsLocator = "CODEX_SUBAGENTS environment variable";
    } else if (workspaceRoot) {
      const agentsDir = path.join(workspaceRoot, ".codex", "agents");
      if (fs.existsSync(agentsDir)) {
        subagentsState = "available";
        subagentsLocator = agentsDir;
      }
    } else {
      const globalAgentsDir = path.join(
        process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
        "agents"
      );
      if (fs.existsSync(globalAgentsDir)) {
        subagentsState = "available";
        subagentsLocator = globalAgentsDir;
      }
    }

    // Threads: inspect real evidence (§25)
    let threadsState: "available" | "unknown" = "unknown";
    let threadsLocator: string | undefined;

    if (process.env.CODEX_THREAD_ID || process.env.CODEX_SESSION_ID) {
      threadsState = "available";
      threadsLocator = "active codex thread/session environment";
    } else if (workspaceRoot) {
      const sessionDirs = [
        path.join(workspaceRoot, ".codex", "sessions"),
        path.join(workspaceRoot, ".codex", "session.db"),
        path.join(workspaceRoot, ".codex", "state.db"),
      ];
      for (const d of sessionDirs) {
        if (fs.existsSync(d)) {
          threadsState = "available";
          threadsLocator = d;
          break;
        }
      }
    } else {
      const globalCodexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
      const globalSessionDirs = [
        path.join(globalCodexHome, "sessions"),
        path.join(globalCodexHome, "session.db"),
        path.join(globalCodexHome, "state.db"),
      ];
      for (const d of globalSessionDirs) {
        if (fs.existsSync(d)) {
          threadsState = "available";
          threadsLocator = d;
          break;
        }
      }
    }

    const modelSelectionState: "available" | "unknown" = models.length > 0 ? "available" : "unknown";
    const perAgentModelSelectionState: "available" | "unknown" =
      subagentsState === "available" ? "available" : "unknown";

    return {
      host_id: "codex",
      adapter_id: "codex",
      workspace: workspaceRoot,
      observed_at: new Date().toISOString(),
      platform: `${os.platform()}-${os.arch()}`,
      available_models: models,
      supported_effort_values: effortValues,
      default_effort_value:
        effortValues.length > 0
          ? effortValues.includes("high")
            ? "high"
            : effortValues[0]
          : undefined,
      capabilities: {
        subagents: {
          state: subagentsState,
          ...(subagentsState === "available"
            ? {
                evidence: {
                  kind: "host-runtime",
                  locator: subagentsLocator || ".codex/agents",
                },
              }
            : {}),
        },
        threads: {
          state: threadsState,
          ...(threadsState === "available"
            ? {
                evidence: {
                  kind: "host-runtime",
                  locator: threadsLocator || ".codex session db",
                },
              }
            : {}),
        },
        parallelism: {
          state: concurrencyState === "available" ? "available" : "unknown",
          ...(concurrencyState === "available"
            ? {
                evidence: {
                  kind: "host-runtime",
                  locator: concurrencyLocator || "codex thread pool",
                },
              }
            : {}),
        },
        model_selection: {
          state: modelSelectionState,
          ...(modelSelectionState === "available"
            ? {
                scopes: ["current-session", "new-session", "per-agent"],
                evidence: {
                  kind: "host-config",
                  locator: configPath || ".codex/config.toml",
                },
              }
            : {}),
        },
        per_agent_model_selection: {
          state: perAgentModelSelectionState,
          ...(perAgentModelSelectionState === "available"
            ? {
                evidence: {
                  kind: "host-config",
                  locator: subagentsLocator || ".codex/agents/*.toml",
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
                  locator: concurrencyLocator || "environment",
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
            locator: configPath || ".codex/config.toml",
          },
        },
        reasoning: {
          state: reasoningState,
          ...(reasoningState === "available"
            ? {
                evidence: {
                  kind: "host-config",
                  locator: configPath || ".codex/config.toml",
                },
              }
            : {}),
        },
      },
    };
  }

  async inspectModels(workspaceRoot?: string): Promise<HostModel[]> {
    const models: HostModel[] = [];
    const seenIds = new Set<string>();

    const checkConfig = (configPath: string) => {
      if (fs.existsSync(configPath)) {
        try {
          const content = fs.readFileSync(configPath, "utf-8");
          const configuredModel = this.extractTomlString(content, "model");
          if (configuredModel && !seenIds.has(configuredModel)) {
            seenIds.add(configuredModel);
            models.push({
              id: configuredModel,
              label: configuredModel,
              state: "available",
              features: ["tools", "reasoning"],
              evidence: {
                kind: "host-config",
                locator: configPath,
              },
            });
          }

          const supported = this.extractTomlArray(content, "supported_models");
          if (supported) {
            for (const sm of supported) {
              if (!seenIds.has(sm)) {
                seenIds.add(sm);
                models.push({
                  id: sm,
                  label: sm,
                  state: "available",
                  features: ["tools", "reasoning"],
                  evidence: {
                    kind: "host-config",
                    locator: configPath,
                  },
                });
              }
            }
          }

          const workerModel = this.extractTomlString(content, "worker_model");
          if (workerModel && !seenIds.has(workerModel)) {
            seenIds.add(workerModel);
            models.push({
              id: workerModel,
              label: workerModel,
              state: "available",
              features: ["tools"],
              evidence: {
                kind: "host-config",
                locator: configPath,
              },
            });
          }
        } catch {
          // Skip
        }
      }
    };

    // 1. Check workspace config
    if (workspaceRoot) {
      const p = path.join(workspaceRoot, ".codex", "config.toml");
      checkConfig(p);
      const rootP = path.join(workspaceRoot, "codex.toml");
      checkConfig(rootP);

      const agentsDir = path.join(workspaceRoot, ".codex", "agents");
      if (fs.existsSync(agentsDir)) {
        try {
          const files = fs.readdirSync(agentsDir);
          for (const file of files) {
            if (file.endsWith(".toml")) {
              const agentContent = fs.readFileSync(path.join(agentsDir, file), "utf-8");
              const agentModel = this.extractTomlString(agentContent, "model");
              if (agentModel && !seenIds.has(agentModel)) {
                seenIds.add(agentModel);
                models.push({
                  id: agentModel,
                  label: agentModel,
                  state: "available",
                  features: ["tools"],
                  evidence: {
                    kind: "host-config",
                    locator: path.join(agentsDir, file),
                  },
                });
              }
            }
          }
        } catch {
          // Skip
        }
      }
    }

    // 2. Check user config only when no workspaceRoot is supplied
    if (!workspaceRoot) {
      const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
      const globalConfig = path.join(codexHome, "config.toml");
      checkConfig(globalConfig);

      const globalAgentsDir = path.join(codexHome, "agents");
      if (fs.existsSync(globalAgentsDir)) {
        try {
          const files = fs.readdirSync(globalAgentsDir);
          for (const file of files) {
            if (file.endsWith(".toml")) {
              const agentContent = fs.readFileSync(path.join(globalAgentsDir, file), "utf-8");
              const agentModel = this.extractTomlString(agentContent, "model");
              if (agentModel && !seenIds.has(agentModel)) {
                seenIds.add(agentModel);
                models.push({
                  id: agentModel,
                  label: agentModel,
                  state: "available",
                  features: ["tools"],
                  evidence: {
                    kind: "host-config",
                    locator: path.join(globalAgentsDir, file),
                  },
                });
              }
            }
          }
        } catch {
          // Skip
        }
      }
    }

    return models;
  }

  async inspectEffortValues(workspaceRoot?: string): Promise<string[]> {
    const configPath = this.resolveConfigPath(workspaceRoot, workspaceRoot ? "project" : undefined);
    if (configPath && fs.existsSync(configPath)) {
      try {
        const content = fs.readFileSync(configPath, "utf-8");
        const customLevels = this.extractTomlArray(content, "supported_effort_values");
        if (customLevels && customLevels.length > 0) {
          return customLevels;
        }
        const configuredEffort = this.extractTomlString(content, "model_reasoning_effort");
        if (configuredEffort) {
          return [configuredEffort];
        }
      } catch {
        // Skip
      }
    }

    return [];
  }

  async inspectReasoningOptions(
    workspaceRoot?: string
  ): Promise<HostReasoningOptions> {
    const effortValues = await this.inspectEffortValues(workspaceRoot);
    return {
      native_field: "model_reasoning_effort",
      supported_values: effortValues,
      default_value:
        effortValues.length > 0
          ? effortValues.includes("high")
            ? "high"
            : effortValues[0]
          : undefined,
    };
  }

  async inspectExecutionTopologyCapabilities(
    workspaceRoot?: string
  ): Promise<TopologyCapabilities> {
    const caps = await this.inspectCapabilities(workspaceRoot);
    const parallelismAvailable = caps.capabilities.parallelism.state === "available";
    const subagentsAvailable = caps.capabilities.subagents.state === "available";
    return {
      supports_single_session: true,
      supports_subagents: subagentsAvailable,
      supports_multi_agent: subagentsAvailable,
      supports_parallel_execution: parallelismAvailable,
      max_concurrency: caps.capabilities.concurrency?.max_concurrency,
      scopes: subagentsAvailable
        ? ["current-session", "new-session", "per-agent"]
        : ["current-session", "new-session"],
    };
  }

  async inspectCompanionRegistration(
    workspaceRoot?: string,
    scope?: "project" | "user"
  ): Promise<CompanionRegistrationStatus> {
    const workspace = workspaceRoot || process.cwd();

    // Check project scope
    if (scope !== "user" && workspaceRoot) {
      const projectTarget = path.join(workspace, ".codex", "config.toml");
      if (fs.existsSync(projectTarget)) {
        try {
          const content = fs.readFileSync(projectTarget, "utf-8");
          const serverConfig = this.extractTomlMcpServer(content, "agent-config");
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

    // Check user scope
    if (scope !== "project") {
      const userCodexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
      const userTarget = path.join(userCodexHome, "config.toml");
      if (fs.existsSync(userTarget)) {
        try {
          const content = fs.readFileSync(userTarget, "utf-8");
          const serverConfig = this.extractTomlMcpServer(content, "agent-config");
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
          // Skip parse error
        }
      }
    }

    const defaultTarget =
      scope === "user" || !workspaceRoot
        ? path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "config.toml")
        : path.join(workspace, ".codex", "config.toml");

    return {
      registered: false,
      scope: scope === "user" || !workspaceRoot ? "global" : "project",
      locator: defaultTarget,
      target_file: defaultTarget,
    };
  }

  async previewCompanionRegistration(
    workspaceRoot?: string,
    scope?: "project" | "user"
  ): Promise<CompanionRegistrationPreview> {
    const workspace = workspaceRoot || process.cwd();
    const targetFile =
      scope === "user" || !workspaceRoot
        ? path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "config.toml")
        : path.join(workspace, ".codex", "config.toml");

    let existingContent: string | null = null;

    if (fs.existsSync(targetFile)) {
      existingContent = await fsp.readFile(targetFile, "utf-8");
    }

    const baselineHash = existingContent
      ? crypto.createHash("sha256").update(existingContent).digest("hex")
      : null;

    const newContent = this.updateTomlMcpServer(
      existingContent || "",
      "agent-config",
      "agent-config",
      ["serve"]
    );
    const diff = createUnifiedDiff(targetFile, existingContent, newContent);
    const previewId = `preview-companion-codex-${Date.now()}`;
    const previewHash = crypto.createHash("sha256").update(newContent).digest("hex");

    return {
      supported: true,
      adapter_id: this.id,
      host_id: this.id,
      scope: scope === "user" || !workspaceRoot ? "global" : "project",
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
        error: preview.error || "Cannot apply companion registration for Codex.",
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
      message: "Codex companion registration applied successfully.",
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
        ? "Codex companion MCP server registration validated successfully."
        : "Codex companion MCP server is not registered.",
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
    _modelId?: string,
    workspaceRoot?: string
  ): Promise<ResolvedReasoningPolicy | undefined> {
    const options = await this.inspectReasoningOptions(workspaceRoot);
    const supported = options.supported_values;
    const normalized = policy.toLowerCase().trim();

    let resolvedValue: string | undefined;

    if (supported.length > 0) {
      if (normalized === "highest-supported") {
        resolvedValue = supported[supported.length - 1];
      } else if (normalized === "lowest-sufficient" || normalized === "lowest-supported") {
        if (supported.includes("low")) resolvedValue = "low";
        else resolvedValue = supported[0];
      } else if (normalized === "configured") {
        resolvedValue = options.default_value || supported[0];
      } else if (supported.includes(policy)) {
        resolvedValue = policy;
      } else {
        const match = supported.find((v) => v.toLowerCase() === normalized);
        if (match) resolvedValue = match;
      }
    } else {
      return undefined;
    }

    if (!resolvedValue) {
      return undefined;
    }

    return {
      host_field: "model_reasoning_effort",
      host_value: resolvedValue,
    };
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
    if (fs.existsSync(configTomlPath)) {
      existingContent = await fsp.readFile(configTomlPath, "utf-8");
    }

    let newConfigContent = existingContent || "";
    newConfigContent = this.updateTomlKeyValue(newConfigContent, "model", targetModel);
    if (targetEffort) {
      newConfigContent = this.updateTomlKeyValue(
        newConfigContent,
        "model_reasoning_effort",
        targetEffort
      );
    }

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

        const itemEffort = extractReasoningPolicy(item);
        let newAgentContent =
          `name = "${item.ticket_id}"\n` +
          `model = "${item.model}"\n`;
        if (itemEffort) {
          newAgentContent += `model_reasoning_effort = "${itemEffort}"\n`;
        }

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
      message: `Codex configuration applied successfully to ${appliedTargets.length} target(s).`,
    };
  }

  async validateConfiguration(
    expected: ExecutionConfig,
    workspaceRoot?: string
  ): Promise<ValidationResult> {
    const workspace = workspaceRoot || process.cwd();
    const configTomlPath = this.resolveConfigPath(workspace) || path.join(workspace, ".codex", "config.toml");

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
      extractReasoningPolicy(expected.execution) ||
      extractReasoningPolicy(expected.controller);

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

    // If work items, validate agent files (§74: validate BOTH worker model AND worker reasoning effort)
    if (expected.work_items) {
      for (const item of expected.work_items) {
        let agentPath = path.join(workspace, ".codex", "agents", `${item.ticket_id}.toml`);
        if (!fs.existsSync(agentPath)) {
          const userAgentsPath = path.join(
            process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
            "agents",
            `${item.ticket_id}.toml`
          );
          if (fs.existsSync(userAgentsPath)) {
            agentPath = userAgentsPath;
          }
        }

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

          // Worker reasoning effort validation (§74)
          const itemEffort = extractReasoningPolicy(item);
          if (itemEffort) {
            const agentEffort = this.extractTomlString(agentContent, "model_reasoning_effort");
            if (agentEffort !== itemEffort) {
              errors.push(
                `Agent '${item.ticket_id}' reasoning effort mismatch: expected '${itemEffort}', actual '${agentEffort}'`
              );
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
        ? "Codex host configuration matches expected execution plan."
        : `Codex configuration drift detected: ${errors.join("; ")}`,
      errors: valid ? undefined : errors,
    };
  }

  resolveConfigPath(workspaceRoot?: string, scope?: "project" | "user"): string | null {
    if (scope === "user") {
      const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
      const p = path.join(codexHome, "config.toml");
      return fs.existsSync(p) ? p : null;
    }

    if (workspaceRoot) {
      const p = path.join(workspaceRoot, ".codex", "config.toml");
      if (fs.existsSync(p)) return p;
      const rootToml = path.join(workspaceRoot, "codex.toml");
      if (fs.existsSync(rootToml)) return rootToml;
      return null;
    }

    const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
    const p = path.join(codexHome, "config.toml");
    if (fs.existsSync(p)) return p;
    return null;
  }

  private extractTomlString(content: string, key: string): string | null {
    const value = rootValue(content, key);
    return typeof value === "string" ? value : null;
  }

  private extractTomlValue(content: string, key: string): string | null {
    const value = rootValue(content, key);
    return typeof value === "number" || typeof value === "boolean" ? String(value) : null;
  }

  private extractTomlArray(content: string, key: string): string[] | null {
    const value = rootValue(content, key);
    return Array.isArray(value) && value.every((item) => typeof item === "string")
      ? value as string[] : null;
  }

  private updateTomlKeyValue(content: string, key: string, value: string): string {
    return updateRootString(content, key, value);
  }

  private extractTomlMcpServer(
    content: string,
    name: string
  ): { command: string; args: string[] } | null {
    const sectionRegex = new RegExp(
      `\\[(?:mcp_servers|mcpServers)\\.${name}\\]([\\s\\S]*?)(?=\\n\\[|\\r?\\n\\[|$)`
    );
    const match = content.match(sectionRegex);
    if (!match) return null;

    const sectionText = match[1];
    const commandMatch = sectionText.match(/^\s*command\s*=\s*"([^"]+)"/m);
    if (!commandMatch) return null;

    const command = commandMatch[1];
    let args: string[] = [];
    const argsMatch = sectionText.match(/^\s*args\s*=\s*\[([^\]]*)\]/m);
    if (argsMatch) {
      args = argsMatch[1]
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter((s) => s.length > 0);
    }

    return { command, args };
  }

  private updateTomlMcpServer(
    content: string,
    name: string,
    command: string,
    args: string[]
  ): string {
    const formattedArgs = `[${args.map((a) => `"${a.replace(/"/g, '\\"')}"`).join(", ")}]`;
    const sectionRegex = new RegExp(
      `(\\[(?:mcp_servers|mcpServers)\\.${name}\\][\\s\\S]*?)(?=\\n\\[|\\r?\\n\\[|$)`
    );

    const block = `[mcp_servers.${name}]\ncommand = "${command}"\nargs = ${formattedArgs}\n`;

    if (sectionRegex.test(content)) {
      return content.replace(sectionRegex, block.trimEnd());
    }

    const trimmed = content.trim();
    return trimmed ? `${trimmed}\n\n${block}` : block;
  }
}
