#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import path from "path";
import { fileURLToPath } from "url";
import { realpathSync } from "fs";
import { ProfileStore } from "../profile/store.js";
import { AdapterRegistry, defaultAdapterRegistry } from "../adapters/registry.js";
import { PreviewManager } from "./preview.js";
import { registerAllTools, ToolContext } from "./tools/index.js";
import { registerCompanionSetupTools } from "../setup/tools.js";
import { runSetupCli } from "../setup/cli.js";

/**
 * Agent Config companion runtime entry point.
 */
export const SERVER_NAME = "agent-config";
export const SERVER_VERSION = "0.1.0";

export interface CreateServerOptions {
  profileStore?: ProfileStore;
  adapterRegistry?: AdapterRegistry;
  previewManager?: PreviewManager;
  includeSetupTools?: boolean;
}

/**
 * Creates and configures an McpServer instance with all 8 core tools.
 */
export function createServer(options?: CreateServerOptions): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  const context: ToolContext = {
    profileStore: options?.profileStore || new ProfileStore(),
    adapterRegistry: options?.adapterRegistry || defaultAdapterRegistry,
    previewManager: options?.previewManager || new PreviewManager(),
  };

  registerAllTools(server, context);

  if (options?.includeSetupTools) {
    registerCompanionSetupTools(server, context);
  }

  return server;
}

/**
 * Starts the companion MCP server connected via standard I/O (stdio).
 */
export async function startServer(options?: CreateServerOptions): Promise<void> {
  const server = createServer(options);
  const transport = new StdioServerTransport();

  await server.connect(transport);
  console.error(
    `${SERVER_NAME} v${SERVER_VERSION} companion MCP server running on stdio`
  );
}

function isDirectExecution(): boolean {
  if (!process.argv[1]) return false;
  try {
    const resolvedArgv = path.resolve(process.argv[1]);
    const currentFile = fileURLToPath(import.meta.url);
    if (resolvedArgv === currentFile) return true;
    if (realpathSync(resolvedArgv) === realpathSync(currentFile)) return true;
  } catch {
    // Fallback to basename check if file resolution fails
  }
  const base = path.basename(process.argv[1]);
  return base === "index.js" || base === "agent-config" || base.startsWith("agent-config");
}

if (isDirectExecution()) {
  if (process.argv[2] === "setup") {
    runSetupCli(process.argv.slice(3)).then((code) => {
      process.exit(code);
    }).catch((error) => {
      console.error("Setup error:", error);
      process.exit(1);
    });
  } else {
    startServer().catch((error) => {
      console.error("Failed to start agent-config server:", error);
      process.exit(1);
    });
  }
}

