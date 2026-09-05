import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ToolContext } from "./context.js";
import {
  InspectHostInputSchema,
  InspectHostOutputSchema,
  InspectHostResult,
} from "../../contracts/index.js";

export { InspectHostInputSchema, InspectHostOutputSchema, InspectHostResult };

export async function handleInspectHost(
  params: { workspace?: string; host_id?: string },
  context: ToolContext
): Promise<InspectHostResult> {
  const workspace = path.resolve(params.workspace || process.cwd());
  const adapter = await context.adapterRegistry.resolveAdapter(
    workspace,
    params.host_id
  );
  return await adapter.inspectCapabilities(workspace);
}

export function registerInspectHostTool(
  server: McpServer,
  context: ToolContext
): void {
  server.registerTool(
    "inspect_host",
    {
      description:
        "Inspect host runtime capabilities, available models, supported effort values, and execution topology.",
      inputSchema: InspectHostInputSchema,
      outputSchema: InspectHostOutputSchema,
    },
    async (params) => {
      try {
        const result = await handleInspectHost(params, context);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result as any,
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: "text", text: `inspect_host error: ${err.message}` }],
        };
      }
    }
  );
}
