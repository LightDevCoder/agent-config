import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ToolContext } from "./context.js";

export const ResetProfileInputSchema = {
  workspace: z
    .string()
    .optional()
    .describe("Workspace directory path (defaults to current working directory)"),
  host_id: z
    .string()
    .optional()
    .describe("Host identifier (optional, auto-detected from adapter if omitted)"),
};

export interface ResetProfileResult {
  success: boolean;
  cleared: boolean;
  message: string;
}

export async function handleResetProfile(
  params: { workspace?: string; host_id?: string },
  context: ToolContext
): Promise<ResetProfileResult> {
  const workspace = path.resolve(params.workspace || process.cwd());
  const adapter = await context.adapterRegistry.resolveAdapter(
    workspace,
    params.host_id
  );
  const hostId = params.host_id || adapter.id;

  const cleared = await context.profileStore.deleteProfile(hostId, workspace);

  return {
    success: true,
    cleared,
    message: cleared
      ? `Profile for host '${hostId}' at workspace '${workspace}' was successfully removed.`
      : `No profile existed for host '${hostId}' at workspace '${workspace}'.`,
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
