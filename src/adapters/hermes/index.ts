import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import childProcess from "node:child_process";
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
  HostModelEvidence,
  extractReasoningPolicy,
} from "../contract.js";
import { ExecutionConfig, AgentProfile } from "../../profile/schema.js";
import { createUnifiedDiff } from "../diff.js";

/**
 * Hermes Native Host Adapter (§49, §50, §51).
 * Supports official Hermes Agent runtime, model resources, multi-provider configuration,
 * profile/scope targets, subagent delegation, and MCP companion lifecycle.
 */
export class HermesAdapter implements HostAdapter {
  readonly id = "hermes";
  readonly name = "Hermes Native Adapter";

  /**
   * Detects active Hermes runtime context from environment or process ancestry.
   */
  hasActiveRuntimeContext(_workspaceRoot?: string): boolean {
    if (
      (process.env.HERMES_HOME && process.env.HERMES_HOME !== "undefined") ||
      (process.env.HERMES_PROFILE && process.env.HERMES_PROFILE !== "undefined") ||
      (process.env.HERMES_CONFIG && process.env.HERMES_CONFIG !== "undefined") ||
      (process.env.HERMES_ENV && process.env.HERMES_ENV !== "undefined") ||
      (process.env.HERMES_INFERENCE_MODEL && process.env.HERMES_INFERENCE_MODEL !== "undefined") ||
      (process.env.HERMES_SESSION && process.env.HERMES_SESSION !== "undefined") ||
      (process.env.HERMES_SESSION_ID && process.env.HERMES_SESSION_ID !== "undefined") ||
      (process.env.HERMES_VERSION && process.env.HERMES_VERSION !== "undefined")
    ) {
      return true;
    }
    if (process.env._ && path.basename(process.env._).toLowerCase().includes("hermes")) {
      return true;
    }
    if (process.title && path.basename(process.title).toLowerCase().includes("hermes")) {
      return true;
    }
    return false;
  }

  /**
   * Identifies whether Hermes is the host harness for this workspace.
   */
  async identifyHost(workspaceRoot?: string): Promise<boolean> {
    if (this.hasActiveRuntimeContext(workspaceRoot)) {
      return true;
    }

    if (workspaceRoot) {
      const candidates = [
        path.join(workspaceRoot, ".hermes"),
        path.join(workspaceRoot, ".hermes", "config.yaml"),
        path.join(workspaceRoot, "hermes.yaml"),
      ];
      if (candidates.some((p) => fs.existsSync(p))) {
        return true;
      }
    }

    if (process.env.HERMES_HOME && fs.existsSync(process.env.HERMES_HOME)) {
      return true;
    }

    if (!workspaceRoot) {
      const userCandidates = [
        path.join(os.homedir(), ".hermes"),
        path.join(os.homedir(), ".hermes", "config.yaml"),
      ];
      return userCandidates.some((p) => fs.existsSync(p));
    }

    return false;
  }

  /**
   * Inspects host version with fail-closed compatibility classification.
   */
  async inspectVersion(workspaceRoot?: string): Promise<HostVersionInfo> {
    // 1. Check CLI hermes -V or hermes --version
    const cliResult = await this.runCliCommand("hermes", ["-V"], workspaceRoot);
    if (cliResult && cliResult.exitCode === 0 && cliResult.stdout.trim()) {
      const verMatch = cliResult.stdout.trim().match(/v?(\d+\.\d+(\.\d+)?(-[a-zA-Z0-9.]+)?)/);
      if (verMatch) {
        return this.classifyVersion(verMatch[1], cliResult.stdout.trim());
      }
    }

    // 2. Check environment variable
    if (process.env.HERMES_VERSION) {
      return this.classifyVersion(process.env.HERMES_VERSION);
    }

    // 3. Check workspace version file
    if (workspaceRoot) {
      const versionFile = path.join(workspaceRoot, ".hermes", "version");
      if (fs.existsSync(versionFile)) {
        try {
          const raw = fs.readFileSync(versionFile, "utf-8").trim();
          if (raw) return this.classifyVersion(raw);
        } catch {
          // ignore
        }
      }
    }

    // 4. Check user version file
    const hermesHome = this.getHermesHome();
    const userVersionFile = path.join(hermesHome, "version");
    if (fs.existsSync(userVersionFile)) {
      try {
        const raw = fs.readFileSync(userVersionFile, "utf-8").trim();
        if (raw) return this.classifyVersion(raw);
      } catch {
        // ignore
      }
    }

    return {
      version: undefined,
      compatibility: "unknown-version",
      fail_closed_for_mutation: true,
      raw: undefined,
    };
  }

  private classifyVersion(versionStr: string, raw?: string): HostVersionInfo {
    const normalized = versionStr.trim();
    if (normalized === "incompatible") {
      return {
        version: normalized,
        compatibility: "incompatible",
        fail_closed_for_mutation: true,
        raw: raw || normalized,
      };
    }
    if (normalized.startsWith("0.") || normalized.startsWith("1.")) {
      return {
        version: normalized,
        compatibility: "supported",
        fail_closed_for_mutation: false,
        raw: raw || normalized,
      };
    }
    if (normalized.startsWith("2.")) {
      return {
        version: normalized,
        compatibility: "partially-supported",
        fail_closed_for_mutation: false,
        raw: raw || normalized,
      };
    }
    return {
      version: normalized,
      compatibility: "unknown-version",
      fail_closed_for_mutation: true,
      raw: raw || normalized,
    };
  }

  /**
   * Inspects host capabilities (models, subagents, delegation, reasoning effort, MCP).
   */
  async inspectCapabilities(workspaceRoot?: string): Promise<HostCapabilities> {
    const configPath = this.resolveConfigPath(workspaceRoot);
    const cfg = this.readConfig(configPath);
    const models = await this.inspectModels(workspaceRoot);
    const effortValues = await this.inspectEffortValues(workspaceRoot);

    // 1. Subagents & Delegation
    let subagentsState: CapabilityState = "unknown";
    let subagentsEvidence: HostModelEvidence | undefined = undefined;

    if (cfg?.delegation !== undefined || (workspaceRoot && fs.existsSync(path.join(workspaceRoot, ".hermes", "skills")))) {
      subagentsState = "available";
      subagentsEvidence = {
        kind: "host-config",
        locator: configPath || "config.yaml",
      };
    } else if (process.env.HERMES_DELEGATION === "1" || process.env.HERMES_DELEGATION === "true") {
      subagentsState = "available";
      subagentsEvidence = {
        kind: "host-runtime",
        locator: "process.env.HERMES_DELEGATION",
      };
    }

    // 2. Parallelism & Concurrency
    let parallelismState: CapabilityState = "unknown";
    let concurrencyState: CapabilityState = "unknown";
    let maxConcurrency: number | undefined = undefined;
    let concurrencyEvidence: HostModelEvidence | undefined = undefined;

    const delegationConcurrency = cfg?.delegation?.max_concurrent_children || cfg?.delegation?.max_iterations;
    const envConcurrency = process.env.HERMES_MAX_CONCURRENCY
      ? parseInt(process.env.HERMES_MAX_CONCURRENCY, 10)
      : undefined;
    const detectedConcurrency = delegationConcurrency || envConcurrency;

    if (detectedConcurrency && detectedConcurrency > 1) {
      maxConcurrency = detectedConcurrency;
      parallelismState = "available";
      concurrencyState = "available";
      concurrencyEvidence = {
        kind: envConcurrency ? "host-runtime" : "host-config",
        locator: envConcurrency ? "process.env.HERMES_MAX_CONCURRENCY" : configPath || "config.yaml",
      };
    }

    // 3. Threads
    const threadsState: CapabilityState = subagentsState === "available" ? "available" : "unknown";

    // 4. Model Selection & Per-agent model selection
    const modelSelectionState: CapabilityState = models.length > 0 ? "available" : "unknown";
    const perAgentModelSelectionState: CapabilityState =
      cfg?.delegation?.model ? "available" : "unknown";

    // 5. Reasoning Capability
    const reasoningState: CapabilityState = effortValues.length > 0 ? "available" : "unknown";

    return {
      host_id: "hermes",
      adapter_id: "hermes",
      workspace: workspaceRoot,
      observed_at: new Date().toISOString(),
      platform: process.platform,
      available_models: models,
      supported_effort_values: effortValues,
      default_effort_value: cfg?.agent?.reasoning_effort || (effortValues.includes("high") ? "high" : effortValues[0]),
      capabilities: {
        subagents: {
          state: subagentsState,
          evidence: subagentsEvidence,
        },
        threads: {
          state: threadsState,
          evidence: subagentsEvidence,
        },
        parallelism: {
          state: parallelismState,
          evidence: concurrencyEvidence,
        },
        model_selection: {
          state: modelSelectionState,
          scopes: modelSelectionState === "available" ? ["current-session", "new-session", "per-agent"] : undefined,
        },
        per_agent_model_selection: {
          state: perAgentModelSelectionState,
        },
        concurrency: {
          state: concurrencyState,
          max_concurrency: maxConcurrency,
          evidence: concurrencyEvidence,
        },
        configuration_mutation: {
          state: "available",
          supports_native_files: true,
          supports_session_mutation: false,
        },
        reasoning: {
          state: reasoningState,
        },
      },
    };
  }

  /**
   * Inspects evidenced models across provider, custom_providers, aliases, delegation, and MOA.
   */
  async inspectModels(workspaceRoot?: string): Promise<HostModel[]> {
    const models: HostModel[] = [];
    const seen = new Set<string>();

    const configPath = this.resolveConfigPath(workspaceRoot);
    const cfg = this.readConfig(configPath);
    const locator = configPath || (workspaceRoot ? path.join(workspaceRoot, ".hermes", "config.yaml") : "config.yaml");

    if (cfg) {
      // 1. Active model
      const activeModel = cfg.model?.default || (typeof cfg.model === "string" ? cfg.model : undefined);
      if (activeModel && !seen.has(activeModel)) {
        seen.add(activeModel);
        models.push({
          id: activeModel,
          label: activeModel,
          state: "available",
          features: ["tools", "hermes-agent"],
          evidence: { kind: "host-config", locator },
        });
      }

      // 2. Model aliases
      if (cfg.model?.aliases && typeof cfg.model.aliases === "object") {
        for (const [alias, target] of Object.entries(cfg.model.aliases)) {
          const targetStr = String(target);
          if (!seen.has(targetStr)) {
            seen.add(targetStr);
            models.push({
              id: targetStr,
              label: `${alias} (${targetStr})`,
              state: "available",
              features: ["tools", "hermes-agent"],
              evidence: { kind: "host-config", locator },
            });
          }
        }
      }

      // 3. Delegation model
      if (cfg.delegation?.model && !seen.has(cfg.delegation.model)) {
        seen.add(cfg.delegation.model);
        models.push({
          id: cfg.delegation.model,
          label: cfg.delegation.model,
          state: "available",
          features: ["subagent", "tools"],
          evidence: { kind: "host-config", locator },
        });
      }

      // 4. Custom providers
      if (Array.isArray(cfg.custom_providers)) {
        for (const cp of cfg.custom_providers) {
          if (cp.models && typeof cp.models === "object") {
            for (const modelKey of Object.keys(cp.models)) {
              if (!seen.has(modelKey)) {
                seen.add(modelKey);
                models.push({
                  id: modelKey,
                  label: `${modelKey} (${cp.name || "custom"})`,
                  state: "available",
                  features: ["tools", "hermes-agent"],
                  evidence: { kind: "host-config", locator },
                });
              }
            }
          }
        }
      }

      // 5. Providers
      if (cfg.providers && typeof cfg.providers === "object") {
        for (const [pName, pVal] of Object.entries<any>(cfg.providers)) {
          if (Array.isArray(pVal?.models)) {
            for (const m of pVal.models) {
              const mStr = String(m);
              if (!seen.has(mStr)) {
                seen.add(mStr);
                models.push({
                  id: mStr,
                  label: `${mStr} (${pName})`,
                  state: "available",
                  features: ["tools", "hermes-agent"],
                  evidence: { kind: "host-config", locator },
                });
              }
            }
          }
        }
      }

      // 6. MOA reference models
      if (Array.isArray(cfg.moa?.reference_models)) {
        for (const rm of cfg.moa.reference_models) {
          if (rm?.model && !seen.has(rm.model)) {
            seen.add(rm.model);
            models.push({
              id: rm.model,
              label: rm.model,
              state: "available",
              features: ["moa", "tools"],
              evidence: { kind: "host-config", locator },
            });
          }
        }
      }
    }

    // 7. Process environment override
    if (process.env.HERMES_INFERENCE_MODEL && !seen.has(process.env.HERMES_INFERENCE_MODEL)) {
      const id = process.env.HERMES_INFERENCE_MODEL.trim();
      seen.add(id);
      models.push({
        id,
        label: id,
        state: "available",
        features: ["tools", "hermes-agent"],
        evidence: { kind: "host-runtime", locator: "env:HERMES_INFERENCE_MODEL" },
      });
    }

    return models;
  }

  /**
   * Inspects supported effort values.
   */
  async inspectEffortValues(workspaceRoot?: string): Promise<string[]> {
    const options = await this.inspectReasoningOptions(workspaceRoot);
    return options.supported_values;
  }

  /**
   * Inspects reasoning options.
   */
  async inspectReasoningOptions(workspaceRoot?: string): Promise<HostReasoningOptions> {
    const configPath = this.resolveConfigPath(workspaceRoot);
    const cfg = this.readConfig(configPath);
    const standardLevels = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

    const currentEffort = cfg?.agent?.reasoning_effort || process.env.HERMES_REASONING_EFFORT;

    return {
      native_field: "agent.reasoning_effort",
      supported_values: standardLevels,
      default_value: currentEffort || "high",
    };
  }

  /**
   * Inspects execution topology capabilities.
   */
  async inspectExecutionTopologyCapabilities(workspaceRoot?: string): Promise<TopologyCapabilities> {
    const caps = await this.inspectCapabilities(workspaceRoot);
    const subagentsAvailable = caps.capabilities.subagents.state === "available";
    const parallelismAvailable = caps.capabilities.parallelism.state === "available";

    return {
      supports_single_session: true,
      supports_subagents: subagentsAvailable,
      supports_multi_agent: subagentsAvailable,
      supports_parallel_execution: parallelismAvailable,
      max_concurrency: caps.capabilities.concurrency?.max_concurrency,
      scopes: subagentsAvailable ? ["current-session", "new-session", "per-agent"] : ["current-session", "new-session"],
    };
  }

  /**
   * Inspects Companion MCP registration status.
   */
  async inspectCompanionRegistration(
    workspaceRoot?: string,
    scope?: "project" | "global" | "user"
  ): Promise<CompanionRegistrationStatus> {
    // Project scope check
    if (scope !== "user" && scope !== "global" && workspaceRoot) {
      const projTarget = path.join(workspaceRoot, ".hermes", "config.yaml");
      if (fs.existsSync(projTarget)) {
        const cfg = this.readConfig(projTarget);
        if (cfg?.mcp_servers?.["agent-config"]) {
          const s = cfg.mcp_servers["agent-config"];
          return {
            registered: s.enabled !== false,
            transport: "stdio",
            scope: "project",
            locator: projTarget,
            command: s.command,
            args: s.args,
            target_file: projTarget,
            details: s,
          };
        }
      }
    }

    // User scope check
    if (scope !== "project") {
      const userTarget = path.join(this.getHermesHome(), "config.yaml");
      if (fs.existsSync(userTarget)) {
        const cfg = this.readConfig(userTarget);
        if (cfg?.mcp_servers?.["agent-config"]) {
          const s = cfg.mcp_servers["agent-config"];
          return {
            registered: s.enabled !== false,
            transport: "stdio",
            scope: "global",
            locator: userTarget,
            command: s.command,
            args: s.args,
            target_file: userTarget,
            details: s,
          };
        }
      }
    }

    const defaultTarget = this.determineTargetConfigPath(workspaceRoot, scope);
    const resolvedScope: "project" | "global" = scope === "user" || scope === "global" || !workspaceRoot ? "global" : "project";

    return {
      registered: false,
      scope: resolvedScope,
      locator: defaultTarget,
      target_file: defaultTarget,
    };
  }

  /**
   * Previews companion registration patch against writable target config.
   */
  async previewCompanionRegistration(
    workspaceRoot?: string,
    scope?: "project" | "global" | "user"
  ): Promise<CompanionRegistrationPreview> {
    const targetFile = this.determineTargetConfigPath(workspaceRoot, scope);
    const resolvedScope: "project" | "global" = scope === "user" || scope === "global" || !workspaceRoot ? "global" : "project";

    let existingContent: string | null = null;
    if (fs.existsSync(targetFile)) {
      existingContent = await fsp.readFile(targetFile, "utf-8");
    }

    const baselineHash = existingContent
      ? crypto.createHash("sha256").update(existingContent).digest("hex")
      : null;

    const newContent = this.updateYamlMcpServer(existingContent || "", "agent-config", "agent-config", ["serve"]);
    const diff = createUnifiedDiff(targetFile, existingContent, newContent);
    const previewId = `preview-companion-hermes-${Date.now()}`;
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

  /**
   * Applies companion registration.
   */
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
        error: preview.error || "Companion registration preview generation failed for Hermes.",
      };
    }

    if (preview.preview_hash !== previewHash) {
      return {
        success: false,
        preview_id: previewHash,
        applied_targets: [],
        error: `Companion registration preview hash mismatch. Expected ${preview.preview_hash}, got ${previewHash}.`,
      };
    }

    // Prioritize CLI hermes mcp add command if available
    const nativeCliResult = await this.runCliCommand(
      "hermes",
      ["mcp", "add", "agent-config", "--command", "agent-config", "--args", "serve"],
      workspaceRoot
    );
    if (nativeCliResult && nativeCliResult.exitCode === 0) {
      return {
        success: true,
        preview_id: preview.preview_id || previewHash,
        applied_targets: preview.mutation_targets,
        message: "Successfully registered companion MCP server via 'hermes mcp add'.",
      };
    }

    // Fall back to applying target configuration file patch
    for (const file of preview.files) {
      const parentDir = path.dirname(file.path);
      if (!fs.existsSync(parentDir)) {
        await fsp.mkdir(parentDir, { recursive: true });
      }
      await fsp.writeFile(file.path, file.content, "utf-8");
    }

    return {
      success: true,
      preview_id: preview.preview_id || previewHash,
      applied_targets: preview.mutation_targets,
      message: "Successfully applied companion MCP registration patch to Hermes config.yaml.",
    };
  }

  /**
   * Validates companion registration via read-back.
   */
  async validateCompanionRegistration(workspaceRoot?: string): Promise<ValidationResult> {
    const status = await this.inspectCompanionRegistration(workspaceRoot);
    return {
      valid: status.registered,
      workspace: workspaceRoot,
      message: status.registered
        ? "Hermes companion MCP server is registered."
        : "Hermes companion MCP server is not registered.",
      details: status,
    };
  }

  /**
   * Previews configuration.
   */
  async previewConfiguration(
    plan: ExecutionConfig,
    profile?: AgentProfile,
    workspaceRoot?: string
  ): Promise<RenderedConfiguration> {
    return this.renderConfiguration(plan, profile, workspaceRoot);
  }

  /**
   * Renders configuration for Hermes respecting scopes.
   */
  async renderConfiguration(
    plan: ExecutionConfig,
    profile?: AgentProfile,
    workspaceRoot?: string
  ): Promise<RenderedConfiguration> {
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

    const targetFile = this.determineTargetConfigPath(workspaceRoot);

    let existingContent: string | null = null;
    if (fs.existsSync(targetFile)) {
      existingContent = await fsp.readFile(targetFile, "utf-8");
    }

    let newContent = existingContent || "";
    newContent = this.updateYamlModelAndEffort(newContent, targetModel, targetEffort);

    const files: RenderedFile[] = [
      {
        path: targetFile,
        content: newContent,
      },
    ];

    let combinedDiff = createUnifiedDiff(targetFile, existingContent, newContent);

    // If decomposed with work items, render worker configurations
    if (plan.work_items && plan.work_items.length > 0) {
      const workerItem = plan.work_items[0];
      if (workerItem?.model) {
        newContent = this.updateYamlDelegation(newContent, workerItem.model);
        files[0].content = newContent;
        combinedDiff = createUnifiedDiff(targetFile, existingContent, newContent);
      }
    }

    const previewId = `preview-hermes-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    return {
      preview_id: previewId,
      mutation_targets: files.map((f) => f.path),
      diff: combinedDiff,
      files,
    };
  }

  /**
   * Applies configuration.
   */
  async applyConfiguration(
    previewId: string,
    rendered?: RenderedConfiguration,
    workspaceRoot?: string
  ): Promise<ApplyResult> {
    if (!rendered || rendered.preview_id !== previewId) {
      return {
        success: false,
        preview_id: previewId,
        applied_targets: [],
        error: `Invalid or missing preview configuration for preview ID '${previewId}'.`,
      };
    }

    const versionInfo = await this.inspectVersion(workspaceRoot);
    if (versionInfo.fail_closed_for_mutation) {
      return {
        success: false,
        preview_id: previewId,
        applied_targets: [],
        error: `Hermes version compatibility '${versionInfo.compatibility}' fails closed for configuration mutation.`,
      };
    }

    const appliedTargets: string[] = [];
    if (rendered.files) {
      for (const file of rendered.files) {
        const parentDir = path.dirname(file.path);
        if (!fs.existsSync(parentDir)) {
          await fsp.mkdir(parentDir, { recursive: true });
        }
        await fsp.writeFile(file.path, file.content, "utf-8");
        appliedTargets.push(file.path);
      }
    }

    return {
      success: true,
      preview_id: previewId,
      applied_targets: appliedTargets,
      message: `Successfully applied Hermes configuration across ${appliedTargets.length} target(s).`,
    };
  }

  /**
   * Validates configuration.
   */
  async validateConfiguration(
    expected: ExecutionConfig,
    workspaceRoot?: string
  ): Promise<ValidationResult> {
    const workspace = workspaceRoot || process.cwd();
    const errors: string[] = [];

    const expectedModel = expected.execution?.model || expected.controller?.model;
    const expectedEffort =
      extractReasoningPolicy(expected.execution) ||
      extractReasoningPolicy(expected.controller);

    const configPath = this.resolveConfigPath(workspaceRoot);
    const cfg = this.readConfig(configPath);

    const actualModel = cfg?.model?.default || (typeof cfg?.model === "string" ? cfg.model : undefined);
    const actualEffort = cfg?.agent?.reasoning_effort;

    if (expectedModel && actualModel !== expectedModel) {
      errors.push(`Controller model mismatch: expected '${expectedModel}', actual '${actualModel}'`);
    }

    if (expectedEffort && actualEffort !== expectedEffort) {
      errors.push(`Reasoning effort mismatch: expected '${expectedEffort}', actual '${actualEffort}'`);
    }

    const valid = errors.length === 0;
    return {
      valid,
      workspace,
      message: valid
        ? "Hermes host configuration matches expected execution plan."
        : `Hermes configuration drift detected: ${errors.join("; ")}`,
      errors: valid ? undefined : errors,
    };
  }

  /**
   * Resolves abstract reasoning policy.
   */
  async resolveReasoningPolicy(
    policy: string,
    _modelId?: string,
    workspaceRoot?: string
  ): Promise<ResolvedReasoningPolicy | undefined> {
    const options = await this.inspectReasoningOptions(workspaceRoot);
    const supported = options.supported_values;
    const normalized = policy.toLowerCase().trim();

    let resolvedValue: string | undefined;

    if (normalized === "highest-supported") {
      resolvedValue = "ultra";
    } else if (normalized === "lowest-sufficient" || normalized === "lowest-supported") {
      resolvedValue = "low";
    } else if (normalized === "configured") {
      resolvedValue = options.default_value || "high";
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
      host_field: "agent.reasoning_effort",
      host_value: resolvedValue,
    };
  }

  // --- Helper methods ---

  private getHermesHome(): string {
    return process.env.HERMES_HOME || path.join(os.homedir(), ".hermes");
  }

  private determineTargetConfigPath(workspaceRoot?: string, scope?: "project" | "global" | "user"): string {
    if (scope === "user" || scope === "global" || !workspaceRoot) {
      return path.join(this.getHermesHome(), "config.yaml");
    }
    return path.join(workspaceRoot, ".hermes", "config.yaml");
  }

  private resolveConfigPath(workspaceRoot?: string): string | null {
    if (workspaceRoot) {
      const projYaml = path.join(workspaceRoot, ".hermes", "config.yaml");
      if (fs.existsSync(projYaml)) return projYaml;
      const rootYaml = path.join(workspaceRoot, "hermes.yaml");
      if (fs.existsSync(rootYaml)) return rootYaml;
    }

    const userYaml = path.join(this.getHermesHome(), "config.yaml");
    if (fs.existsSync(userYaml)) return userYaml;

    return null;
  }

  private readConfig(filePath: string | null): any {
    if (!filePath || !fs.existsSync(filePath)) return null;
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      return this.parseSimpleYaml(content);
    } catch {
      return null;
    }
  }

  /**
   * Lightweight YAML parser supporting Hermes config sections:
   * model, providers, custom_providers, agent, delegation, mcp_servers, moa.
   */
  private parseSimpleYaml(content: string): any {
    const root: any = {};
    const lines = content.split(/\r?\n/);
    const stack: Array<{ indent: number; obj: any; key?: string }> = [{ indent: -1, obj: root }];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim() || line.trim().startsWith("#")) continue;

      const indent = line.search(/\S/);
      const trimmed = line.trim();

      while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
        stack.pop();
      }
      const parent = stack[stack.length - 1].obj;

      if (trimmed.startsWith("- ")) {
        // List item
        const itemVal = trimmed.slice(2).trim();
        if (Array.isArray(parent)) {
          if (itemVal.includes(":") && !itemVal.startsWith("{")) {
            const [k, ...v] = itemVal.split(":");
            const obj: any = {};
            obj[k.trim()] = this.parseScalar(v.join(":").trim());
            parent.push(obj);
            stack.push({ indent, obj });
          } else {
            parent.push(this.parseScalar(itemVal));
          }
        }
        continue;
      }

      const colonIdx = trimmed.indexOf(":");
      if (colonIdx > 0) {
        const key = trimmed.slice(0, colonIdx).trim();
        const rawVal = trimmed.slice(colonIdx + 1).trim();

        if (!rawVal) {
          // New object or array
          const nextLine = lines[i + 1];
          const nextTrimmed = nextLine ? nextLine.trim() : "";
          const isNextArray = nextTrimmed.startsWith("- ");
          const childObj = isNextArray ? [] : {};
          if (Array.isArray(parent)) {
            const entry: any = {};
            entry[key] = childObj;
            parent.push(entry);
          } else {
            parent[key] = childObj;
          }
          stack.push({ indent, obj: childObj, key });
        } else {
          const val = this.parseScalar(rawVal);
          if (Array.isArray(parent)) {
            const entry: any = {};
            entry[key] = val;
            parent.push(entry);
          } else {
            parent[key] = val;
          }
        }
      }
    }

    return root;
  }

  private parseScalar(val: string): any {
    if (!val) return "";
    if (val === "true") return true;
    if (val === "false") return false;
    if (val === "null" || val === "~") return null;
    if (/^-?\d+$/.test(val)) return parseInt(val, 10);
    if (/^-?\d+\.\d+$/.test(val)) return parseFloat(val);
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      return val.slice(1, -1);
    }
    return val;
  }

  private updateYamlModelAndEffort(content: string, model: string, effort?: string): string {
    let res = content;
    const hasModelSection = /^\s*model:\s*$/m.test(res);
    if (hasModelSection) {
      if (/^\s*default:\s*.*$/m.test(res)) {
        res = res.replace(/^(\s*default:\s*).*$/m, `$1${model}`);
      } else {
        res = res.replace(/^(\s*model:\s*$)/m, `$1\n  default: ${model}`);
      }
    } else {
      res = `model:\n  default: ${model}\n` + res;
    }

    if (effort) {
      const hasAgentSection = /^\s*agent:\s*$/m.test(res);
      if (hasAgentSection) {
        if (/^\s*reasoning_effort:\s*.*$/m.test(res)) {
          res = res.replace(/^(\s*reasoning_effort:\s*).*$/m, `$1${effort}`);
        } else {
          res = res.replace(/^(\s*agent:\s*$)/m, `$1\n  reasoning_effort: ${effort}`);
        }
      } else {
        res += `\nagent:\n  reasoning_effort: ${effort}\n`;
      }
    }

    return res;
  }

  private updateYamlDelegation(content: string, model: string): string {
    let res = content;
    const hasDelegation = /^\s*delegation:\s*$/m.test(res);
    if (hasDelegation) {
      if (/^\s*model:\s*.*$/m.test(res)) {
        res = res.replace(/^(\s*delegation:[\s\S]*?^\s*model:\s*).*$/m, `$1${model}`);
      } else {
        res = res.replace(/^(\s*delegation:\s*$)/m, `$1\n  model: ${model}`);
      }
    } else {
      res += `\ndelegation:\n  model: ${model}\n`;
    }
    return res;
  }

  private updateYamlMcpServer(
    content: string,
    name: string,
    command: string,
    args: string[]
  ): string {
    if (content.includes(`mcp_servers:\n  ${name}:`) || content.includes(`  ${name}:`)) {
      return content;
    }

    const argsYaml = args.map((a) => `      - ${a}`).join("\n");
    const serverBlock = `  ${name}:\n    command: ${command}\n    args:\n${argsYaml}\n    enabled: true\n`;

    const hasMcpSection = /^\s*mcp_servers:\s*$/m.test(content);
    if (hasMcpSection) {
      return content.replace(/^(\s*mcp_servers:\s*$)/m, `$1\n${serverBlock}`);
    }

    const trimmed = content.trim();
    return trimmed ? `${trimmed}\n\nmcp_servers:\n${serverBlock}` : `mcp_servers:\n${serverBlock}`;
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
