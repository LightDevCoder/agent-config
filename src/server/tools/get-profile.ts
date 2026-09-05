import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ToolContext } from "./context.js";
import {
  GetProfileInputSchema,
  GetProfileResult,
  ScopeType,
} from "../../contracts/index.js";

export { GetProfileInputSchema, GetProfileResult };

export async function handleGetProfile(
  params: { scope?: ScopeType; workspace?: string; host_id?: string },
  context: ToolContext
): Promise<GetProfileResult> {
  const workspace = path.resolve(params.workspace || process.cwd());
  const adapter = await context.adapterRegistry.resolveAdapter(
    workspace,
    params.host_id
  );
  const hostCapabilities = await adapter.inspectCapabilities(workspace);
  const hostId = params.host_id || hostCapabilities?.host_id;
  if (!hostId) {
    throw new Error("Unable to determine host ID from input or host inspection.");
  }
  const lookupTarget = params.scope === "global" ? "global" : workspace;

  const profile = await context.profileStore.getProfile(hostId, lookupTarget);
  if (!profile) {
    return {
      found: false,
      message: `No stored profile found for host '${hostId}' and workspace '${lookupTarget}'.`,
    };
  }

  return {
    found: true,
    profile,
  };
}

export function registerGetProfileTool(
  server: McpServer,
  context: ToolContext
): void {
  server.registerTool(
    "get_profile",
    {
      description:
        "Retrieve the stored, user-confirmed Agent Config profile for the specified host and workspace.",
      inputSchema: GetProfileInputSchema,
    },
    async (params) => {
      try {
        const result = await handleGetProfile(params, context);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: "text", text: `get_profile error: ${err.message}` }],
        };
      }
    }
  );
}
