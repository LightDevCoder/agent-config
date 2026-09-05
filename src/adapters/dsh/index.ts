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
  resolveHostReasoningPolicy,
} from "../contract.js";
import { ExecutionConfig, AgentProfile } from "../../profile/schema.js";
import { createUnifiedDiff } from "../diff.js";

/**
 * Standard subagent providers recognized by DSH Cordis architecture (§41).
 */
export const KNOWN_SUBAGENT_PROVIDERS = [
  "in-process",
  "fork",
  "acp",
  "codex",
  "claude-code",
  "dsh-sdk",
] as const;

export type DshSubagentProvider =
  | (typeof KNOWN_SUBAGENT_PROVIDERS)[number]
  | (string & {});

/**
 * DeepSeek Harness (DSH) Native Adapter based on Cordis runtime and plugin-composed capabilities.
 * Inspects active plugins, mounted services, subagent providers, LLM adapters, and MCP clients;
 * enforces fail-closed version safety; and supports companion MCP integration (§39, §40, §41, §42, §43).
 */
export class DshAdapter implements HostAdapter {
  readonly id = "dsh";
  readonly name = "DeepSeek Harness Adapter";

  /**
   * Detects active DSH / Cordis runtime environment from process environment or ancestry.
   */
  hasActiveRuntimeContext(_workspaceRoot?: string): boolean {
    if (
      process.env.DSH_RUNTIME === "1" ||
      process.env.DSH_RUNTIME === "true" ||
      process.env.DEEPSEEK_HARNESS === "1" ||
      process.env.DEEPSEEK_HARNESS === "true" ||
      (process.env.CORDIS_APP && process.env.CORDIS_APP !== "undefined") ||
      (process.env.DSH_PLUGINS && process.env.DSH_PLUGINS !== "undefined") ||
      (process.env.DSH_SERVICES && process.env.DSH_SERVICES !== "undefined") ||
      (process.env.DSH_MOUNTED_SERVICES &&
        process.env.DSH_MOUNTED_SERVICES !== "undefined") ||
      (process.env.DSH_SUBAGENT_PROVIDERS &&
        process.env.DSH_SUBAGENT_PROVIDERS !== "undefined") ||
      (process.env.DSH_SESSION_ID && process.env.DSH_SESSION_ID !== "undefined") ||
      (process.env.DSH_AGENT && process.env.DSH_AGENT !== "undefined") ||
      (process.env.DSH_HOME && process.env.DSH_HOME !== "undefined") ||
      (process.env.DSH_CONFIG && process.env.DSH_CONFIG !== "undefined") ||
      (process.env.DSH_VERSION && process.env.DSH_VERSION !== "undefined")
    ) {
      return true;
    }
    if (process.env._ && /dsh|cordis|deepseek-harness/i.test(path.basename(process.env._))) {
      return true;
    }
    if (process.title && /dsh|cordis|deepseek-harness/i.test(path.basename(process.title))) {
      return true;
    }
    return false;
  }

  /**
   * Identifies if DeepSeek Harness (DSH) is the host harness for this workspace.
   */
  async identifyHost(workspaceRoot?: string): Promise<boolean> {
    if (this.hasActiveRuntimeContext(workspaceRoot)) {
      return true;
    }

    if (workspaceRoot) {
      const candidates = [
        path.join(workspaceRoot, ".dsh"),
        path.join(workspaceRoot, "dsh.config.json"),
        path.join(workspaceRoot, "dsh.config.ts"),
        path.join(workspaceRoot, "dsh.config.js"),
        path.join(workspaceRoot, "dsh.config.yaml"),
        path.join(workspaceRoot, "dsh.config.yml"),
        path.join(workspaceRoot, "dsh.yml"),
        path.join(workspaceRoot, "dsh.yaml"),
        path.join(workspaceRoot, ".cordis"),
        path.join(workspaceRoot, "cordis.yml"),
        path.join(workspaceRoot, "cordis.yaml"),
        path.join(workspaceRoot, "cordis.json"),
      ];
      if (candidates.some((p) => fs.existsSync(p))) {
        return true;
      }
    }

    if (process.env.DSH_HOME && fs.existsSync(process.env.DSH_HOME)) {
      return true;
    }

    if (!workspaceRoot) {
      const userCandidates = [
        path.join(os.homedir(), ".dsh"),
        path.join(os.homedir(), ".config", "dsh"),
        path.join(os.homedir(), ".cordis"),
        path.join(os.homedir(), ".dsh.json"),
      ];
      return userCandidates.some((p) => fs.existsSync(p));
    }

    return false;
  }

  /**
   * Inspects DSH host version and plugin API compatibility (§42).
   * Developer-preview versions or unknown versions fail-closed for mutation while permitting read-only inspection.
   */
  async inspectVersion(workspaceRoot?: string): Promise<HostVersionInfo> {
    let version = process.env.DSH_VERSION;
    let pluginApiVersion = process.env.DSH_PLUGIN_API_VERSION;
    let raw: string | undefined = version;

    if (!version && workspaceRoot) {
      const versionFile = path.join(workspaceRoot, ".dsh", "version");
      if (fs.existsSync(versionFile)) {
        try {
          raw = fs.readFileSync(versionFile, "utf-8").trim();
          version = raw;
        } catch {
          // Skip
        }
      } else {
        const configFiles = [
          path.join(workspaceRoot, "dsh.config.json"),
          path.join(workspaceRoot, ".dsh", "config.json"),
        ];
        for (const cf of configFiles) {
          if (fs.existsSync(cf)) {
            try {
              const parsed = jsonc.parse(fs.readFileSync(cf, "utf-8"));
              if (parsed && typeof parsed.version === "string") {
                version = parsed.version;
                raw = parsed.version;
              }
              if (parsed && typeof parsed.pluginApiVersion === "string") {
                pluginApiVersion = parsed.pluginApiVersion;
              } else if (parsed && typeof parsed.plugin_api_version === "string") {
                pluginApiVersion = parsed.plugin_api_version;
              }
              break;
            } catch {
              // Skip
            }
          }
        }
      }
    }

    if (!version) {
      const userVersionFile = path.join(os.homedir(), ".dsh", "version");
      if (fs.existsSync(userVersionFile)) {
        try {
          raw = fs.readFileSync(userVersionFile, "utf-8").trim();
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

    const normalized = version.trim().toLowerCase();
    if (normalized === "incompatible" || normalized.includes("incompatible")) {
      return {
        version,
        compatibility: "incompatible",
        fail_closed_for_mutation: true,
        raw,
      };
    }

    // Check developer-preview markers in version or plugin API version (§42)
    const isDeveloperPreview =
      normalized.includes("preview") ||
      normalized.includes("dev") ||
      normalized.includes("alpha") ||
      normalized.includes("beta") ||
      normalized.includes("canary") ||
      normalized.includes("rc") ||
      (pluginApiVersion !== undefined &&
        (pluginApiVersion.toLowerCase().includes("preview") ||
          pluginApiVersion.toLowerCase().includes("dev") ||
          pluginApiVersion.toLowerCase().includes("alpha") ||
          pluginApiVersion.toLowerCase().includes("beta")));

    if (isDeveloperPreview) {
      return {
        version,
        compatibility: "partially-supported",
        fail_closed_for_mutation: true,
        raw,
      };
    }

    // Supported versions: 0.x, 1.x, 2.x stable
    if (
      normalized.startsWith("0.") ||
      normalized.startsWith("1.") ||
      normalized.startsWith("2.") ||
      normalized.startsWith("v0.") ||
      normalized.startsWith("v1.") ||
      normalized.startsWith("v2.")
    ) {
      return {
        version,
        compatibility: "supported",
        fail_closed_for_mutation: false,
        raw,
      };
    }

    return {
      version,
      compatibility: "unknown-version",
      fail_closed_for_mutation: true,
      raw,
    };
  }

  /**
   * Inspects active plugins loaded in the DSH Cordis runtime (§39, §40).
   */
  async inspectActivePlugins(workspaceRoot?: string): Promise<string[]> {
    const plugins = new Set<string>();

    // 1. Environment variable DSH_PLUGINS
    if (process.env.DSH_PLUGINS) {
      const raw = process.env.DSH_PLUGINS.trim();
      if (raw.startsWith("[") || raw.startsWith("{")) {
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            for (const item of parsed) {
              if (typeof item === "string") plugins.add(item.trim());
            }
          } else if (parsed && typeof parsed === "object") {
            for (const key of Object.keys(parsed)) {
              plugins.add(key.trim());
            }
          }
        } catch {
          raw
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
            .forEach((p) => plugins.add(p));
        }
      } else {
        raw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .forEach((p) => plugins.add(p));
      }
    }

    // 2. Config files in workspace
    const workspace = workspaceRoot || process.cwd();
    const configFiles = [
      path.join(workspace, "dsh.config.json"),
      path.join(workspace, ".dsh", "config.json"),
      path.join(workspace, ".dsh", "plugins.json"),
    ];

    for (const cf of configFiles) {
      if (fs.existsSync(cf)) {
        try {
          const content = fs.readFileSync(cf, "utf-8");
          const parsed = jsonc.parse(content);
          if (parsed) {
            if (Array.isArray(parsed.active_plugins)) {
              parsed.active_plugins.forEach((p: string) => plugins.add(p));
            }
            if (Array.isArray(parsed.active)) {
              parsed.active.forEach((p: string) => plugins.add(p));
            }
            if (Array.isArray(parsed.plugins)) {
              parsed.plugins.forEach((p: any) => {
                if (typeof p === "string") plugins.add(p);
                else if (p && typeof p.name === "string") plugins.add(p.name);
              });
            } else if (parsed.plugins && typeof parsed.plugins === "object") {
              Object.keys(parsed.plugins).forEach((p) => plugins.add(p));
            }
          }
        } catch {
          // Skip
        }
      }
    }

    return Array.from(plugins);
  }

  /**
   * Inspects mounted services in the DSH Cordis context (§39, §40).
   * Models, tools, skills, sessions, sandboxes, loops, scheduling, subagents, workflows, MCP.
   */
  async inspectMountedServices(workspaceRoot?: string): Promise<string[]> {
    const services = new Set<string>();

    // 1. Environment variable DSH_SERVICES or DSH_MOUNTED_SERVICES
    const envServices =
      process.env.DSH_SERVICES || process.env.DSH_MOUNTED_SERVICES;
    if (envServices) {
      const raw = envServices.trim();
      if (raw.startsWith("[")) {
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            parsed.forEach((s) => typeof s === "string" && services.add(s.trim().toLowerCase()));
          }
        } catch {
          raw
            .split(",")
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean)
            .forEach((s) => services.add(s));
        }
      } else {
        raw
          .split(",")
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean)
          .forEach((s) => services.add(s));
      }
    }

    // 2. Config files
    const workspace = workspaceRoot || process.cwd();
    const configFiles = [
      path.join(workspace, "dsh.config.json"),
      path.join(workspace, ".dsh", "config.json"),
      path.join(workspace, ".dsh", "plugins.json"),
    ];

    for (const cf of configFiles) {
      if (fs.existsSync(cf)) {
        try {
          const content = fs.readFileSync(cf, "utf-8");
          const parsed = jsonc.parse(content);
          if (parsed) {
            if (Array.isArray(parsed.services)) {
              parsed.services.forEach((s: string) => services.add(s.trim().toLowerCase()));
            }
            if (Array.isArray(parsed.mounted_services)) {
              parsed.mounted_services.forEach((s: string) =>
                services.add(s.trim().toLowerCase())
              );
            }
          }
        } catch {
          // Skip
        }
      }
    }

    // 3. Infer from active plugins
    const activePlugins = await this.inspectActivePlugins(workspaceRoot);
    for (const p of activePlugins) {
      const lower = p.toLowerCase();
      if (lower.includes("llm") || lower.includes("deepseek") || lower.includes("model")) {
        services.add("models");
      }
      if (lower.includes("tool")) services.add("tools");
      if (lower.includes("skill")) services.add("skills");
      if (lower.includes("subagent")) services.add("subagents");
      if (lower.includes("mcp")) services.add("mcp");
      if (lower.includes("sandbox")) services.add("sandboxes");
      if (lower.includes("loop")) services.add("loops");
      if (lower.includes("schedul")) services.add("scheduling");
      if (lower.includes("workflow")) services.add("workflows");
      if (lower.includes("session")) services.add("sessions");
    }

    return Array.from(services);
  }

  /**
   * Inspects active preset or mode in DSH (§39).
   */
  async inspectActivePreset(workspaceRoot?: string): Promise<string | undefined> {
    if (process.env.DSH_PRESET) {
      return process.env.DSH_PRESET.trim();
    }
    if (process.env.DSH_MODE) {
      return process.env.DSH_MODE.trim();
    }

    const workspace = workspaceRoot || process.cwd();
    const configFiles = [
      path.join(workspace, "dsh.config.json"),
      path.join(workspace, ".dsh", "config.json"),
    ];

    for (const cf of configFiles) {
      if (fs.existsSync(cf)) {
        try {
          const content = fs.readFileSync(cf, "utf-8");
          const parsed = jsonc.parse(content);
          if (parsed) {
            if (typeof parsed.preset === "string") return parsed.preset.trim();
            if (typeof parsed.mode === "string") return parsed.mode.trim();
          }
        } catch {
          // Skip
        }
      }
    }

    return undefined;
  }

  /**
   * Inspects actual active subagent providers loaded in DSH (§41).
   * Only reports providers that are actually loaded/active. Never hardcodes availability.
   */
  async inspectSubagentProviders(workspaceRoot?: string): Promise<string[]> {
    const providers = new Set<string>();

    // 1. Environment variable DSH_SUBAGENT_PROVIDERS
    if (process.env.DSH_SUBAGENT_PROVIDERS) {
      const raw = process.env.DSH_SUBAGENT_PROVIDERS.trim();
      if (raw.startsWith("[")) {
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            parsed.forEach((item) => {
              if (typeof item === "string") providers.add(item.trim().toLowerCase());
            });
          }
        } catch {
          raw
            .split(",")
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean)
            .forEach((p) => providers.add(p));
        }
      } else {
        raw
          .split(",")
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean)
          .forEach((p) => providers.add(p));
      }
    }

    // 2. Active plugins
    const activePlugins = await this.inspectActivePlugins(workspaceRoot);
    for (const plugin of activePlugins) {
      const p = plugin.toLowerCase();
      for (const known of KNOWN_SUBAGENT_PROVIDERS) {
        if (
          p === known ||
          p === `@dsh/plugin-subagent-${known}` ||
          p === `subagent-${known}` ||
          p.endsWith(`/${known}`)
        ) {
          providers.add(known);
        }
      }
    }

    // 3. Workspace config inspection
    const workspace = workspaceRoot || process.cwd();
    const configFiles = [
      path.join(workspace, "dsh.config.json"),
      path.join(workspace, ".dsh", "config.json"),
      path.join(workspace, ".dsh", "plugins.json"),
      path.join(workspace, ".dsh", "subagents.json"),
    ];

    for (const cf of configFiles) {
      if (fs.existsSync(cf)) {
        try {
          const content = fs.readFileSync(cf, "utf-8");
          const parsed = jsonc.parse(content);
          if (parsed) {
            if (Array.isArray(parsed.subagents?.providers)) {
              parsed.subagents.providers.forEach((pr: string) =>
                providers.add(pr.trim().toLowerCase())
              );
            }
            if (parsed.plugins && typeof parsed.plugins === "object") {
              const subagentsPlugin =
                parsed.plugins["@dsh/plugin-subagents"] ||
                parsed.plugins["subagents"] ||
                parsed.plugins["subagent"];
              if (subagentsPlugin && Array.isArray(subagentsPlugin.providers)) {
                subagentsPlugin.providers.forEach((pr: string) =>
                  providers.add(pr.trim().toLowerCase())
                );
              }
            }
            if (Array.isArray(parsed.providers)) {
              parsed.providers.forEach((pr: string) =>
                providers.add(pr.trim().toLowerCase())
              );
            }
          }
        } catch {
          // Skip
        }
      }
    }

    return Array.from(providers);
  }

  /**
   * Inspects models available through LLM adapter plugins or environment (§40).
   * Strictly avoids inventing unevidenced models.
   */
  async inspectModels(workspaceRoot?: string): Promise<HostModel[]> {
    const modelsMap = new Map<string, HostModel>();

    // 1. Environment variable DSH_MODELS or DSH_MODEL
    if (process.env.DSH_MODELS) {
      const raw = process.env.DSH_MODELS.trim();
      let modelIds: string[] = [];
      if (raw.startsWith("[")) {
        try {
          modelIds = JSON.parse(raw);
        } catch {
          modelIds = raw.split(",").map((s) => s.trim()).filter(Boolean);
        }
      } else {
        modelIds = raw.split(",").map((s) => s.trim()).filter(Boolean);
      }
      for (const id of modelIds) {
        modelsMap.set(id, {
          id,
          state: "available",
          evidence: { kind: "host-runtime", locator: "process.env.DSH_MODELS" },
        });
      }
    }

    if (process.env.DSH_MODEL) {
      const id = process.env.DSH_MODEL.trim();
      if (id && !modelsMap.has(id)) {
        modelsMap.set(id, {
          id,
          state: "available",
          evidence: { kind: "host-runtime", locator: "process.env.DSH_MODEL" },
        });
      }
    }

    // 2. Config files
    const workspace = workspaceRoot || process.cwd();
    const configFiles = [
      path.join(workspace, "dsh.config.json"),
      path.join(workspace, ".dsh", "config.json"),
    ];

    for (const cf of configFiles) {
      if (fs.existsSync(cf)) {
        try {
          const content = fs.readFileSync(cf, "utf-8");
          const parsed = jsonc.parse(content);
          if (parsed) {
            if (typeof parsed.model === "string" && parsed.model.trim()) {
              const id = parsed.model.trim();
              if (!modelsMap.has(id)) {
                modelsMap.set(id, {
                  id,
                  state: "available",
                  evidence: { kind: "host-config", locator: `${cf}:model` },
                });
              }
            }
            if (Array.isArray(parsed.models)) {
              for (const m of parsed.models) {
                const id = typeof m === "string" ? m : m?.id;
                if (id && !modelsMap.has(id)) {
                  modelsMap.set(id, {
                    id,
                    state: "available",
                    evidence: { kind: "host-config", locator: `${cf}:models` },
                  });
                }
              }
            }
            if (parsed.plugins && typeof parsed.plugins === "object") {
              for (const [pKey, pConfig] of Object.entries<any>(parsed.plugins)) {
                if (pConfig && typeof pConfig === "object") {
                  if (typeof pConfig.model === "string" && pConfig.model.trim()) {
                    const id = pConfig.model.trim();
                    if (!modelsMap.has(id)) {
                      modelsMap.set(id, {
                        id,
                        state: "available",
                        evidence: {
                          kind: "host-config",
                          locator: `${cf}:plugins.${pKey}.model`,
                        },
                      });
                    }
                  }
                  if (Array.isArray(pConfig.models)) {
                    for (const m of pConfig.models) {
                      const id = typeof m === "string" ? m : m?.id;
                      if (id && !modelsMap.has(id)) {
                        modelsMap.set(id, {
                          id,
                          state: "available",
                          evidence: {
                            kind: "host-config",
                            locator: `${cf}:plugins.${pKey}.models`,
                          },
                        });
                      }
                    }
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

    return Array.from(modelsMap.values());
  }

  /**
   * Inspects reasoning effort options supported by DSH (§11, §19).
   */
  async inspectReasoningOptions(
    workspaceRoot?: string
  ): Promise<HostReasoningOptions> {
    const values = new Set<string>();
    let defaultValue: string | undefined;

    // 1. Environment variable DSH_REASONING_EFFORT
    if (process.env.DSH_REASONING_EFFORT) {
      const val = process.env.DSH_REASONING_EFFORT.trim().toLowerCase();
      values.add(val);
      defaultValue = val;
    }

    // 2. Config files
    const workspace = workspaceRoot || process.cwd();
    const configFiles = [
      path.join(workspace, "dsh.config.json"),
      path.join(workspace, ".dsh", "config.json"),
    ];

    for (const cf of configFiles) {
      if (fs.existsSync(cf)) {
        try {
          const content = fs.readFileSync(cf, "utf-8");
          const parsed = jsonc.parse(content);
          if (parsed) {
            if (typeof parsed.reasoning_effort === "string") {
              const v = parsed.reasoning_effort.trim().toLowerCase();
              values.add(v);
              if (!defaultValue) defaultValue = v;
            }
            if (Array.isArray(parsed.supported_reasoning_efforts)) {
              parsed.supported_reasoning_efforts.forEach((v: string) =>
                values.add(v.trim().toLowerCase())
              );
            }
            if (parsed.reasoning && Array.isArray(parsed.reasoning.supported_values)) {
              parsed.reasoning.supported_values.forEach((v: string) =>
                values.add(v.trim().toLowerCase())
              );
            }
            if (parsed.plugins && typeof parsed.plugins === "object") {
              for (const pConfig of Object.values<any>(parsed.plugins)) {
                if (pConfig && typeof pConfig === "object") {
                  if (typeof pConfig.reasoning_effort === "string") {
                    const v = pConfig.reasoning_effort.trim().toLowerCase();
                    values.add(v);
                    if (!defaultValue) defaultValue = v;
                  }
                  if (Array.isArray(pConfig.supported_reasoning_efforts)) {
                    pConfig.supported_reasoning_efforts.forEach((v: string) =>
                      values.add(v.trim().toLowerCase())
                    );
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

    return {
      native_field: "reasoning_effort",
      supported_values: Array.from(values),
      default_value: defaultValue,
    };
  }

  async inspectEffortValues(workspaceRoot?: string): Promise<string[]> {
    return (await this.inspectReasoningOptions(workspaceRoot)).supported_values;
  }

  /**
   * Inspects execution topology capabilities (§19, §40, §41).
   * Parallel execution derived from evidenced concurrency > 1.
   * Subagent execution strictly derived from active subagent provider plugins.
   */
  async inspectExecutionTopologyCapabilities(
    workspaceRoot?: string
  ): Promise<TopologyCapabilities> {
    const subagentProviders = await this.inspectSubagentProviders(workspaceRoot);
    const hasSubagents = subagentProviders.length > 0;

    let maxConcurrency: number | undefined;
    if (process.env.DSH_MAX_CONCURRENCY) {
      const parsed = parseInt(process.env.DSH_MAX_CONCURRENCY, 10);
      if (!isNaN(parsed) && parsed > 0) {
        maxConcurrency = parsed;
      }
    }

    if (maxConcurrency === undefined) {
      const workspace = workspaceRoot || process.cwd();
      const configFiles = [
        path.join(workspace, "dsh.config.json"),
        path.join(workspace, ".dsh", "config.json"),
      ];
      for (const cf of configFiles) {
        if (fs.existsSync(cf)) {
          try {
            const content = fs.readFileSync(cf, "utf-8");
            const parsed = jsonc.parse(content);
            if (
              parsed &&
              typeof parsed.concurrency === "number" &&
              parsed.concurrency > 0
            ) {
              maxConcurrency = parsed.concurrency;
              break;
            }
            if (
              parsed &&
              typeof parsed.max_concurrency === "number" &&
              parsed.max_concurrency > 0
            ) {
              maxConcurrency = parsed.max_concurrency;
              break;
            }
          } catch {
            // Skip
          }
        }
      }
    }

    const supportsParallel = maxConcurrency !== undefined && maxConcurrency > 1;

    return {
      supports_single_session: true,
      supports_subagents: hasSubagents,
      supports_multi_agent: hasSubagents,
      supports_parallel_execution: supportsParallel,
      max_concurrency: maxConcurrency,
      scopes: hasSubagents
        ? ["current-session", "new-session", "per-agent"]
        : ["current-session", "new-session"],
    };
  }

  /**
   * Inspects host capabilities with strict tri-state unknown semantics (§40, §41).
   * DSH presence alone does NOT imply subagents are available!
   */
  async inspectCapabilities(workspaceRoot?: string): Promise<HostCapabilities> {
    const isDsh = await this.identifyHost(workspaceRoot);
    const models = await this.inspectModels(workspaceRoot);
    const reasoningOpts = await this.inspectReasoningOptions(workspaceRoot);
    const subagentProviders = await this.inspectSubagentProviders(workspaceRoot);
    const topology = await this.inspectExecutionTopologyCapabilities(workspaceRoot);

    const hasModels = models.length > 0;
    const hasReasoning = reasoningOpts.supported_values.length > 0;
    const hasSubagents = subagentProviders.length > 0;
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
          state: hasSubagents ? "available" : isDsh ? "unavailable" : "unknown",
          evidence: hasSubagents
            ? {
                kind: "host-runtime",
                locator: `dsh.subagent-providers:${subagentProviders.join(",")}`,
              }
            : undefined,
        },
        per_agent_model_selection: {
          state: hasSubagents ? "available" : isDsh ? "unavailable" : "unknown",
        },
        threads: {
          state: isDsh ? "available" : "unknown",
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
   * Resolves target configuration path for DSH.
   */
  determineTargetConfigPath(workspaceRoot: string): string {
    const dshDirConfig = path.join(workspaceRoot, ".dsh", "config.json");
    if (fs.existsSync(dshDirConfig)) {
      return dshDirConfig;
    }
    return path.join(workspaceRoot, "dsh.config.json");
  }

  /**
   * Inspects companion MCP server registration in DSH (§43).
   * Checks whether MCP client plugin is active/present AND whether agent-config server is configured.
   */
  async inspectCompanionRegistration(
    workspaceRoot?: string,
    scope?: "project" | "global" | "user"
  ): Promise<CompanionRegistrationStatus> {
    const workspace = workspaceRoot || process.cwd();
    const targetFile = this.determineTargetConfigPath(workspace);

    const activePlugins = await this.inspectActivePlugins(workspaceRoot);
    const mcpPluginActive = activePlugins.some(
      (p) =>
        p === "@dsh/plugin-mcp" ||
        p === "mcp" ||
        p === "mcp-client" ||
        p === "cordis-plugin-mcp" ||
        p.toLowerCase().includes("mcp")
    );

    let mcpPluginInConfig = false;
    let serverEntry: { command: string; args?: string[] } | undefined;
    let detectedPluginKey: string | undefined;

    const candidateFiles = [
      targetFile,
      path.join(workspace, "dsh.config.json"),
      path.join(workspace, ".dsh", "config.json"),
    ];

    for (const cf of candidateFiles) {
      if (fs.existsSync(cf)) {
        try {
          const content = fs.readFileSync(cf, "utf-8");
          const parsed = jsonc.parse(content);
          if (parsed && parsed.plugins && typeof parsed.plugins === "object") {
            for (const [key, val] of Object.entries<any>(parsed.plugins)) {
              if (
                key === "@dsh/plugin-mcp" ||
                key === "mcp" ||
                key === "mcp-client" ||
                key.toLowerCase().includes("mcp")
              ) {
                mcpPluginInConfig = true;
                detectedPluginKey = key;
                if (val && typeof val === "object") {
                  const servers = val.mcpServers || val.servers;
                  if (servers && servers["agent-config"]) {
                    serverEntry = servers["agent-config"];
                    break;
                  }
                }
              }
            }
          }
          if (
            !serverEntry &&
            parsed &&
            parsed.mcpServers &&
            parsed.mcpServers["agent-config"]
          ) {
            serverEntry = parsed.mcpServers["agent-config"];
          }
          if (serverEntry) break;
        } catch {
          // Skip
        }
      }
    }

    const isMcpPluginPresent = mcpPluginActive || mcpPluginInConfig;
    const isRegistered = isMcpPluginPresent && !!serverEntry;
    const resolvedScope: "project" | "global" =
      scope === "global" || scope === "user" || (!scope && !workspaceRoot)
        ? "global"
        : "project";

    if (isRegistered && serverEntry) {
      return {
        registered: true,
        transport: "stdio",
        scope: resolvedScope,
        locator: targetFile,
        command: serverEntry.command,
        args: serverEntry.args,
        target_file: targetFile,
        details: {
          mcp_plugin: detectedPluginKey || "@dsh/plugin-mcp",
          mcp_plugin_active: mcpPluginActive,
          config: serverEntry,
        },
      };
    }

    return {
      registered: false,
      scope: resolvedScope,
      locator: targetFile,
      target_file: targetFile,
      details: {
        mcp_plugin_detected: isMcpPluginPresent,
        mcp_plugin_active: mcpPluginActive,
        server_entry_configured: !!serverEntry,
      },
    };
  }

  /**
   * Previews companion MCP registration mutations (§43).
   * Enforces fail-closed safety on developer-preview or unknown versions (§42).
   */
  async previewCompanionRegistration(
    workspaceRoot?: string,
    scope?: "project" | "global" | "user"
  ): Promise<CompanionRegistrationPreview> {
    const workspace = workspaceRoot || process.cwd();
    const targetFile = this.determineTargetConfigPath(workspace);
    const resolvedScope: "project" | "global" = (scope === "global" || scope === "user" || (!scope && !workspaceRoot)) ? "global" : "project";

    // Fail-closed version safety check (§42)
    const versionInfo = await this.inspectVersion(workspaceRoot);
    if (versionInfo.fail_closed_for_mutation) {
      return {
        supported: false,
        adapter_id: this.id,
        host_id: this.id,
        scope: resolvedScope,
        target_file: targetFile,
        mutation_targets: [],
        error: `DSH version '${
          versionInfo.version || "unknown"
        }' is not approved for mutation (fail-closed version safety per SPEC §42). Read-only inspection is permitted.`,
      };
    }

    let existingContent: string | null = null;
    let currentText =
      '{\n  "version": "1.0.0",\n  "pluginApiVersion": "1.0.0",\n  "plugins": {}\n}\n';

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
          error: `DSH configuration file at '${targetFile}' contains syntax errors. Rejecting companion registration to prevent data loss.`,
        };
      }
      currentText = existingContent;
    }

    let mcpKey = "@dsh/plugin-mcp";
    try {
      const parsed = jsonc.parse(currentText);
      if (parsed && parsed.plugins && typeof parsed.plugins === "object") {
        if ("mcp" in parsed.plugins) mcpKey = "mcp";
        else if ("mcp-client" in parsed.plugins) mcpKey = "mcp-client";
        else if ("@dsh/plugin-mcp" in parsed.plugins) mcpKey = "@dsh/plugin-mcp";
      }
    } catch {
      // Keep default
    }

    const formatting = { formattingOptions: { insertSpaces: true, tabSize: 2 } };
    const edits = jsonc.modify(
      currentText,
      ["plugins", mcpKey, "mcpServers", "agent-config"],
      { command: "agent-config", args: ["serve"] },
      formatting
    );
    const newContent = jsonc.applyEdits(currentText, edits);
    const diff = createUnifiedDiff(targetFile, existingContent, newContent);
    const previewId = `preview-companion-dsh-${Date.now()}`;
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

  /**
   * Applies companion MCP registration to DSH configuration (§43).
   */
  async applyCompanionRegistration(
    previewHash: string,
    workspaceRoot?: string
  ): Promise<ApplyResult> {
    const versionInfo = await this.inspectVersion(workspaceRoot);
    if (versionInfo.fail_closed_for_mutation) {
      return {
        success: false,
        preview_id: previewHash,
        applied_targets: [],
        error: `DSH version '${
          versionInfo.version || "unknown"
        }' is not approved for mutation (fail-closed version safety per SPEC §42).`,
      };
    }

    const preview = await this.previewCompanionRegistration(workspaceRoot);
    if (!preview.supported || !preview.files || preview.files.length === 0) {
      return {
        success: false,
        preview_id: previewHash,
        applied_targets: [],
        error: preview.error || "Cannot apply companion registration for DSH.",
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
      message: "DSH companion MCP registration applied successfully.",
    };
  }

  /**
   * Validates DSH companion MCP registration and reachable status (§43).
   */
  async validateCompanionRegistration(
    workspaceRoot?: string
  ): Promise<ValidationResult> {
    const status = await this.inspectCompanionRegistration(workspaceRoot);
    return {
      valid: status.registered,
      workspace: workspaceRoot,
      message: status.registered
        ? "DSH companion MCP registration validated successfully via active MCP plugin."
        : "DSH companion MCP registration is not active or incomplete.",
    };
  }

  async previewConfiguration(
    plan: ExecutionConfig,
    profile?: AgentProfile,
    workspaceRoot?: string
  ): Promise<RenderedConfiguration> {
    return this.renderConfiguration(plan, profile, workspaceRoot);
  }

  /**
   * Renders DSH configuration changes, diff, and mutation files without touching the filesystem.
   */
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
      plan.controller?.effort_policy;

    let existingContent: string | null = null;
    let currentText =
      '{\n  "version": "1.0.0",\n  "pluginApiVersion": "1.0.0",\n  "plugins": {}\n}\n';

    if (fs.existsSync(targetFile)) {
      existingContent = await fsp.readFile(targetFile, "utf-8");
      const parseErrors: jsonc.ParseError[] = [];
      jsonc.parse(existingContent, parseErrors, { allowTrailingComma: true });
      if (parseErrors.length > 0) {
        throw new Error(
          `DSH configuration file at '${targetFile}' contains syntax errors. Rejecting mutation to prevent configuration loss.`
        );
      }
      currentText = existingContent;
    }

    const formatting = { formattingOptions: { insertSpaces: true, tabSize: 2 } };

    let llmKey = "@dsh/plugin-llm";
    try {
      const parsed = jsonc.parse(currentText);
      if (parsed && parsed.plugins && typeof parsed.plugins === "object") {
        if ("@dsh/plugin-deepseek" in parsed.plugins) llmKey = "@dsh/plugin-deepseek";
        else if ("deepseek" in parsed.plugins) llmKey = "deepseek";
        else if ("llm" in parsed.plugins) llmKey = "llm";
      }
    } catch {
      // Keep default
    }

    // 1. Root model and LLM plugin model
    let edits = jsonc.modify(currentText, ["model"], targetModel, formatting);
    currentText = jsonc.applyEdits(currentText, edits);

    edits = jsonc.modify(
      currentText,
      ["plugins", llmKey, "model"],
      targetModel,
      formatting
    );
    currentText = jsonc.applyEdits(currentText, edits);

    // 2. Reasoning effort
    if (targetEffort) {
      edits = jsonc.modify(currentText, ["reasoning_effort"], targetEffort, formatting);
      currentText = jsonc.applyEdits(currentText, edits);
      edits = jsonc.modify(
        currentText,
        ["plugins", llmKey, "reasoning_effort"],
        targetEffort,
        formatting
      );
      currentText = jsonc.applyEdits(currentText, edits);
    }

    // 3. Work items rendered into subagent profiles
    if (plan.work_items && plan.work_items.length > 0) {
      for (const item of plan.work_items) {
        const profileVal: Record<string, any> = {
          model: item.model,
        };
        if (item.effort || item.effort_policy) {
          profileVal.reasoning_effort = item.effort || item.effort_policy;
        }
        const profileEdits = jsonc.modify(
          currentText,
          ["plugins", "@dsh/plugin-subagents", "profiles", item.ticket_id],
          profileVal,
          formatting
        );
        currentText = jsonc.applyEdits(currentText, profileEdits);
      }
    }

    const files: RenderedFile[] = [
      {
        path: targetFile,
        content: currentText,
      },
    ];

    const diff = createUnifiedDiff(targetFile, existingContent, currentText);
    const previewId = `preview-dsh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const versionInfo = await this.inspectVersion(workspaceRoot);

    return {
      preview_id: previewId,
      mutation_targets: files.map((f) => f.path),
      diff,
      files,
      raw: {
        version_safety: {
          fail_closed: versionInfo.fail_closed_for_mutation,
          version: versionInfo.version,
          compatibility: versionInfo.compatibility,
        },
      },
    };
  }

  /**
   * Applies rendered configuration to DSH configuration files.
   * Enforces fail-closed safety for unknown or developer-preview versions (§42).
   */
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

    const versionInfo = await this.inspectVersion(workspaceRoot);
    if (versionInfo.fail_closed_for_mutation) {
      return {
        success: false,
        preview_id: previewId,
        applied_targets: [],
        error: `DSH version '${
          versionInfo.version || "unknown"
        }' is not approved for mutation (fail-closed version safety per SPEC §42). Read-only inspection is permitted.`,
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
      message: `DSH configuration applied successfully to ${appliedTargets.length} target(s).`,
    };
  }

  /**
   * Validates DSH configuration against expected execution plan.
   */
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
        message: `DSH configuration file not found at ${targetFile}`,
        errors: [`Configuration file missing: ${targetFile}`],
      };
    }

    try {
      const content = await fsp.readFile(targetFile, "utf-8");
      const parsed = jsonc.parse(content);
      if (!parsed) {
        return {
          valid: false,
          workspace,
          message: "Failed to parse DSH configuration file.",
          errors: ["Configuration file could not be parsed."],
        };
      }

      const expectedModel =
        expected.execution?.model || expected.controller?.model;
      const errors: string[] = [];

      const actualModel =
        parsed.model ||
        parsed.plugins?.["@dsh/plugin-llm"]?.model ||
        parsed.plugins?.["@dsh/plugin-deepseek"]?.model ||
        parsed.plugins?.["deepseek"]?.model ||
        parsed.plugins?.["llm"]?.model;

      if (expectedModel && actualModel !== expectedModel) {
        errors.push(`Expected model '${expectedModel}', found '${actualModel}'`);
      }

      const expectedEffort =
        expected.execution?.effort ||
        expected.execution?.effort_policy ||
        expected.controller?.effort ||
        expected.controller?.effort_policy;

      const actualEffort =
        parsed.reasoning_effort ||
        parsed.plugins?.["@dsh/plugin-llm"]?.reasoning_effort ||
        parsed.plugins?.["@dsh/plugin-deepseek"]?.reasoning_effort ||
        parsed.plugins?.["deepseek"]?.reasoning_effort;

      if (expectedEffort && actualEffort !== expectedEffort) {
        errors.push(
          `Expected reasoning effort '${expectedEffort}', found '${actualEffort}'`
        );
      }

      return {
        valid: errors.length === 0,
        workspace,
        message:
          errors.length === 0
            ? "DSH configuration validated successfully."
            : `DSH configuration validation failed: ${errors.join("; ")}`,
        errors: errors.length > 0 ? errors : undefined,
        details: {
          targetFile,
          actualModel,
          actualEffort,
        },
      };
    } catch (err: any) {
      return {
        valid: false,
        workspace,
        message: `Error validating DSH configuration: ${err.message}`,
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
    if (options.supported_values.length === 0) {
      return undefined;
    }

    const values = options.supported_values;
    const normalized = policy.toLowerCase().trim();

    let selectedValue: string | undefined;
    if (normalized === "highest-supported") {
      if (values.includes("high")) selectedValue = "high";
      else if (values.includes("medium")) selectedValue = "medium";
      else selectedValue = values[values.length - 1];
    } else if (normalized === "lowest-sufficient" || normalized === "lowest-supported") {
      if (values.includes("low")) selectedValue = "low";
      else selectedValue = values[0];
    } else if (normalized === "configured") {
      selectedValue = options.default_value || values[0];
    } else if (values.includes(policy)) {
      selectedValue = policy;
    } else {
      const match = values.find((v) => v.toLowerCase() === normalized);
      if (match) selectedValue = match;
    }

    if (!selectedValue) return undefined;
    return {
      host_field: options.native_field,
      host_value: selectedValue,
    };
  }
}
