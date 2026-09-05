import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ToolContext } from "./context.js";
import {
  ResetProfileInputSchema,
  ResetProfileResult,
  ScopeType,
} from "../../contracts/index.js";

export { ResetProfileInputSchema, ResetProfileResult };

export async function handleResetProfile(
  params: { scope?: ScopeType; workspace?: string; host_id?: string },
  context: ToolContext
): Promise<ResetProfileResult> {
  const workspace = path.resolve(params.workspace || process.cwd());
  const adapter = await context.adapterRegistry.resolveAdapter(
    workspace,
    params.host_id
  );
  const hostId = params.host_id || adapter.id;
  const targetScope = params.scope || "project";
  const targetWorkspace = targetScope === "global" ? "global" : workspace;

  const cleared = await context.profileStore.deleteProfile(hostId, targetWorkspace);

  return {
    success: true,
    cleared,
    reset: cleared,
    host_id: hostId,
    scope: targetScope,
    message: cleared
      ? `Profile for host '${hostId}' (${targetScope}) at '${targetWorkspace}' was successfully removed.`
      : `No profile existed for host '${hostId}' (${targetScope}) at '${targetWorkspace}'.`,
  };
}

export function registerResetProfileTool(
  server: McpServer,
  context: ToolContext
): void {
  server.registerTool(
    "reset_profile",
    {
      description:
        "Safely clear and remove the host-scoped profile for the specified workspace.",
      inputSchema: ResetProfileInputSchema,
    },
    async (params) => {
      try {
        const result = await handleResetProfile(params, context);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: "text", text: `reset_profile error: ${err.message}` }],
        };
      }
    }
  );
}
