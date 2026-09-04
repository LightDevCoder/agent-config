import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ToolContext } from "./context.js";
import { checkProfileStale } from "../../profile/stale.js";

export const GetSetupStatusInputSchema = {
  workspace: z
    .string()
    .optional()
    .describe("Workspace directory path (defaults to current working directory)"),
  host_id: z
    .string()
    .optional()
    .describe("Host identifier (optional, auto-detected from adapter if omitted)"),
};

export interface SetupStatusResult {
  configured: boolean;
  profile_version: number | null;
  host_id: string;
  adapter_id: string | null;
  scope: "project" | "global" | null;
  stale: boolean;
  stale_reasons: string[];
}

export async function handleGetSetupStatus(
  params: { workspace?: string; host_id?: string },
  context: ToolContext
): Promise<SetupStatusResult> {
  const workspace = path.resolve(params.workspace || process.cwd());
  const adapter = await context.adapterRegistry.resolveAdapter(
    workspace,
    params.host_id
  );
  const hostId = params.host_id || adapter.id;

  const profile = await context.profileStore.getProfile(hostId, workspace);
  if (!profile) {
    return {
      configured: false,
      profile_version: null,
      host_id: hostId,
      adapter_id: adapter.id,
      scope: null,
      stale: false,
      stale_reasons: [],
    };
  }

  // Check staleness against current host capabilities
  const hostCapabilities = await adapter.inspectCapabilities(workspace);
  const staleCheck = checkProfileStale(profile, hostCapabilities);

  return {
    configured: true,
    profile_version: profile.profile_version,
    host_id: profile.host.id,
    adapter_id: profile.host.adapter,
    scope: profile.scope.type,
    stale: staleCheck.stale,
    stale_reasons: staleCheck.reasons,
  };
}

export function registerGetSetupStatusTool(
  server: McpServer,
  context: ToolContext
): void {
  server.registerTool(
    "get_setup_status",
    {
      description:
        "Check current Agent Config setup status, profile version, host/adapter IDs, and stale status.",
      inputSchema: GetSetupStatusInputSchema,
    },
    async (params) => {
      try {
        const result = await handleGetSetupStatus(params, context);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: "text", text: `get_setup_status error: ${err.message}` }],
        };
      }
    }
  );
}
