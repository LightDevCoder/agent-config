import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ToolContext } from "./context.js";
import { Profile } from "../../profile/schema.js";

export const GetProfileInputSchema = {
  workspace: z
    .string()
    .optional()
    .describe("Workspace directory path (defaults to current working directory)"),
  host_id: z
    .string()
    .optional()
    .describe("Host identifier (optional, auto-detected from adapter if omitted)"),
};

export interface GetProfileResult {
  found: boolean;
  profile?: Profile;
  message?: string;
}

export async function handleGetProfile(
  params: { workspace?: string; host_id?: string },
  context: ToolContext
): Promise<GetProfileResult> {
  const workspace = path.resolve(params.workspace || process.cwd());
  const adapter = await context.adapterRegistry.resolveAdapter(
    workspace,
    params.host_id
  );
  const hostId = params.host_id || adapter.id;

  const profile = await context.profileStore.getProfile(hostId, workspace);
  if (!profile) {
    return {
      found: false,
      message: `No stored profile found for host '${hostId}' and workspace '${workspace}'.`,
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
