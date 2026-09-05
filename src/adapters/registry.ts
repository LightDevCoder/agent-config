import { HostAdapter } from "./contract.js";
import { GenericAdapter } from "./generic/index.js";
import { CodexAdapter } from "./codex/index.js";
import { OpenCodeAdapter } from "./opencode/index.js";
import { ClaudeCodeAdapter } from "./claude-code/index.js";
import { CopilotCliAdapter } from "./copilot-cli/index.js";
import { GeminiCliAdapter } from "./gemini-cli/index.js";
import { CursorAdapter } from "./cursor/index.js";
import { KiroAdapter } from "./kiro/index.js";
import { ZedAdapter } from "./zed/index.js";
import { DshAdapter } from "./dsh/index.js";
import { GrokBuildAdapter } from "./grok-build/index.js";
import { AmpAdapter } from "./amp/index.js";
import { WindsurfAdapter } from "./windsurf/index.js";
import { ClineAdapter } from "./cline/index.js";
import { RooCodeAdapter } from "./roo-code/index.js";

export type DisambiguationHandler = (
  candidates: string[]
) => Promise<string | undefined> | string | undefined;

export interface ResolveAdapterOptions {
  disambiguate?: DisambiguationHandler;
  throwOnAmbiguity?: boolean;
}

export class AmbiguousHostError extends Error {
  readonly candidates: string[];

  constructor(candidates: string[]) {
    super(
      `Multiple host candidates detected (${candidates.join(
        ", "
      )}). Disambiguation required: specify host_id or configure disambiguation handler.`
    );
    this.name = "AmbiguousHostError";
    this.candidates = candidates;
  }
}

/**
 * Central registry managing host adapter instances and resolving them against workspaces (§51, §52, §90).
 */
export class AdapterRegistry {
  private adapters: Map<string, HostAdapter> = new Map();
  private defaultAdapter: HostAdapter;
  private disambiguationHandler?: DisambiguationHandler;

  constructor(defaultAdapter?: HostAdapter) {
    this.defaultAdapter = defaultAdapter || new GenericAdapter();

    // Register built-in adapters
    this.register(new CodexAdapter());
    this.register(new OpenCodeAdapter());
    this.register(new ClaudeCodeAdapter());
    this.register(new CopilotCliAdapter());
    this.register(new GeminiCliAdapter());
    this.register(new CursorAdapter());
    this.register(new KiroAdapter());
    this.register(new ZedAdapter());
    this.register(new DshAdapter());
    this.register(new GrokBuildAdapter());
    this.register(new AmpAdapter());
    this.register(new WindsurfAdapter());
    this.register(new ClineAdapter());
    this.register(new RooCodeAdapter());
    this.register(this.defaultAdapter);
  }

  register(adapter: HostAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  getAdapter(id: string): HostAdapter | undefined {
    return this.adapters.get(id);
  }

  setDisambiguationHandler(handler?: DisambiguationHandler): void {
    this.disambiguationHandler = handler;
  }

  /**
   * Detects all registered host adapters that identify as valid for the workspace (§20).
   * Excludes fallback generic adapter.
   */
  async detectAllCandidates(workspacePath?: string): Promise<string[]> {
    const candidates: string[] = [];
    for (const adapter of this.adapters.values()) {
      if (adapter.id === "generic") continue;
      try {
        if (await adapter.identifyHost(workspacePath)) {
          candidates.push(adapter.id);
        }
      } catch {
        // Ignore identification error and continue checking next adapter
      }
    }
    return candidates;
  }

  /**
   * Resolves the most appropriate adapter for a workspace (§20, §51).
   * 1. If hostId is provided, returns that adapter directly.
   * 2. Detects all matching host candidates.
   * 3. If zero candidates, falls back to default adapter.
   * 4. If exactly one candidate, returns it.
   * 5. If multiple candidates match:
   *    a. Checks active runtime context (environment variables, process ancestry) for disambiguation.
   *    b. If still ambiguous, invokes disambiguation handler if provided.
   *    c. Otherwise throws AmbiguousHostError to prevent silently guessing the first binary found.
   */
  async resolveAdapter(
    workspacePath?: string,
    hostId?: string,
    options?: ResolveAdapterOptions
  ): Promise<HostAdapter> {
    if (hostId && this.adapters.has(hostId)) {
      return this.adapters.get(hostId)!;
    }

    const candidates = await this.detectAllCandidates(workspacePath);

    if (candidates.length === 0) {
      return this.defaultAdapter;
    }

    if (candidates.length === 1) {
      return this.adapters.get(candidates[0])!;
    }

    // Multiple candidates detected: check for active runtime evidence
    const runtimeCandidates: string[] = [];
    for (const candidateId of candidates) {
      const adapter = this.adapters.get(candidateId);
      if (adapter?.hasActiveRuntimeContext) {
        try {
          const hasContext = await adapter.hasActiveRuntimeContext(workspacePath);
          if (hasContext) {
            runtimeCandidates.push(candidateId);
          }
        } catch {
          // Ignore error and continue
        }
      }
    }

    if (runtimeCandidates.length === 1) {
      return this.adapters.get(runtimeCandidates[0])!;
    }

    const targetCandidates =
      runtimeCandidates.length > 1 ? runtimeCandidates : candidates;

    // Disambiguation handler (e.g. asking user or interactive choice)
    const handler = options?.disambiguate || this.disambiguationHandler;
    if (handler) {
      const selected = await handler(targetCandidates);
      if (selected && this.adapters.has(selected)) {
        return this.adapters.get(selected)!;
      }
    }

    if (options?.throwOnAmbiguity ?? true) {
      throw new AmbiguousHostError(targetCandidates);
    }

    return this.adapters.get(targetCandidates[0]) || this.defaultAdapter;
  }

  listAdapters(): HostAdapter[] {
    return Array.from(this.adapters.values());
  }
}

export const defaultAdapterRegistry = new AdapterRegistry();

