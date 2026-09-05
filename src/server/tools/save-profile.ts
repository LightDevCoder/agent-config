import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ToolContext } from "./context.js";
import { Profile, ProfileSchema } from "../../profile/schema.js";
import { validateProfileAgainstJsonSchema } from "../../profile/validator.js";
import {
  SaveProfileInputSchema,
  SaveProfileResult,
} from "../../contracts/index.js";

export { SaveProfileInputSchema, SaveProfileResult };

export async function handleSaveProfile(
  params: { profile: unknown; workspace?: string },
  context: ToolContext
): Promise<SaveProfileResult> {
  // 1. Validate raw profile against canonical JSON schema before any stripping
  const jsonValidation = validateProfileAgainstJsonSchema(params.profile);
  if (!jsonValidation.valid) {
    throw new Error(
      `Profile failed canonical schema validation:\n${jsonValidation.errors?.join("\n")}`
    );
  }

  const parsed = ProfileSchema.parse(params.profile);
  const isGlobal = parsed.scope.type === "global";
  const targetWorkspace = isGlobal
    ? "global"
    : path.resolve(
        params.workspace || parsed.scope.workspace || process.cwd()
      );

  // Synchronize scope.workspace if workspace override was specified
  const profileToSave: Profile = {
    ...parsed,
    scope: {
      ...parsed.scope,
      workspace: targetWorkspace,
    },
    updated_at: new Date().toISOString(),
  };

  if (!profileToSave.created_at) {
    profileToSave.created_at = profileToSave.updated_at;
  }

  // Inspect current host capabilities to validate inventory & efforts
  const inspectionWorkspace = isGlobal
    ? (params.workspace ? path.resolve(params.workspace) : process.cwd())
    : targetWorkspace;

  const adapter = await context.adapterRegistry.resolveAdapter(
    inspectionWorkspace,
    profileToSave.host.adapter
  );
  const hostCapabilities = await adapter.inspectCapabilities(inspectionWorkspace);

  // Save atomically with validation against host capabilities
  await context.profileStore.saveProfile(profileToSave, {
    hostCapabilities,
  });

  return {
    success: true,
    message: `Profile saved successfully for host '${profileToSave.host.id}' at workspace '${targetWorkspace}'.`,
    profile: profileToSave,
  };
}

export function registerSaveProfileTool(
  server: McpServer,
  context: ToolContext
): void {
  server.registerTool(
    "save_profile",
    {
      description:
        "Atomically validate and save a user-confirmed Agent Config profile.",
      inputSchema: SaveProfileInputSchema,
    },
    async (params) => {
      try {
        const result = await handleSaveProfile(params, context);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: "text", text: `save_profile error: ${err.message}` }],
        };
      }
    }
  );
}
