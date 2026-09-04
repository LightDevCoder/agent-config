import { HostAdapter } from "./contract.js";
import { GenericAdapter } from "./generic/index.js";
import { CodexAdapter } from "./codex/index.js";
import { OpenCodeAdapter } from "./opencode/index.js";

/**
 * Registry managing host adapter instances and resolving them against workspaces.
 */
export class AdapterRegistry {
  private adapters: Map<string, HostAdapter> = new Map();
  private defaultAdapter: HostAdapter;

  constructor(defaultAdapter?: HostAdapter) {
    this.defaultAdapter = defaultAdapter || new GenericAdapter();

    // Register built-in adapters
    this.register(new CodexAdapter());
    this.register(new OpenCodeAdapter());
    this.register(this.defaultAdapter);
  }

  register(adapter: HostAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  getAdapter(id: string): HostAdapter | undefined {
    return this.adapters.get(id);
  }

  /**
   * Resolves the most appropriate adapter for a workspace.
   * If a specific hostId is requested, looks up that adapter.
   * Otherwise iterates registered adapters in order, returning the first whose
   * identifyHost returns true, or falls back to the default adapter.
   */
  async resolveAdapter(
    workspacePath?: string,
    hostId?: string
  ): Promise<HostAdapter> {
    if (hostId && this.adapters.has(hostId)) {
      return this.adapters.get(hostId)!;
    }

    for (const adapter of this.adapters.values()) {
      if (adapter.id === "generic") continue;
      try {
        if (await adapter.identifyHost(workspacePath)) {
          return adapter;
        }
      } catch {
        // Ignore identification error and check next adapter
      }
    }

    return this.defaultAdapter;
  }

  listAdapters(): HostAdapter[] {
    return Array.from(this.adapters.values());
  }
}

export const defaultAdapterRegistry = new AdapterRegistry();
