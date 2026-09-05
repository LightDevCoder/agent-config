import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ToolContext } from "./context.js";
import { checkProfileStale } from "../../profile/stale.js";
import {
  GetSetupStatusInputSchema,
  SetupStatusResult,
  PROTOCOL_VERSION,
  ScopeType,
} from "../../contracts/index.js";

export { GetSetupStatusInputSchema, SetupStatusResult };

export async function handleGetSetupStatus(
  params: { scope?: ScopeType; workspace?: string; host_id?: string },
  context: ToolContext
): Promise<SetupStatusResult> {
  const workspace = path.resolve(params.workspace || process.cwd());
  const adapter = await context.adapterRegistry.resolveAdapter(
    workspace,
    params.host_id
  );
  const hostId = params.host_id || adapter.id;
  const lookupTarget = params.scope === "global" ? "global" : workspace;

  const companionStatus = await adapter.inspectCompanionRegistration(
    workspace,
    params.scope as any
  );

  const profile = await context.profileStore.getProfile(hostId, lookupTarget);
  if (!profile) {
    return {
      configured: false,
      protocol_version: PROTOCOL_VERSION,
      profile_version: null,
      host_id: hostId,
      adapter_id: adapter.id,
      scope: null,
      stale: false,
      stale_reasons: [],
      companion_registered: companionStatus.registered,
      companion_status: companionStatus,
    };
  }

  // Check staleness against current host capabilities
  const hostCapabilities = await adapter.inspectCapabilities(workspace);
  const staleCheck = checkProfileStale(profile, hostCapabilities);

  return {
    configured: true,
    protocol_version: PROTOCOL_VERSION,
    profile_version: profile.profile_version,
    host_id: profile.host.id,
    adapter_id: profile.host.adapter,
    scope: profile.scope.type,
    stale: staleCheck.stale,
    stale_reasons: staleCheck.reasons,
    companion_registered: companionStatus.registered,
    companion_status: companionStatus,
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
