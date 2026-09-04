import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ProfileStore } from "../profile/store.js";
import { AdapterRegistry, defaultAdapterRegistry } from "../adapters/registry.js";
import { PreviewManager } from "./preview.js";
import { registerAllTools, ToolContext } from "./tools/index.js";

/**
 * Agent Config companion runtime entry point.
 */
export const SERVER_NAME = "agent-config";
export const SERVER_VERSION = "0.1.0";

export interface CreateServerOptions {
  profileStore?: ProfileStore;
  adapterRegistry?: AdapterRegistry;
  previewManager?: PreviewManager;
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

if (process.argv[1] && process.argv[1].endsWith("index.js")) {
  startServer().catch((error) => {
    console.error("Failed to start agent-config server:", error);
    process.exit(1);
  });
}
