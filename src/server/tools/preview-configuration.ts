import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ToolContext } from "./context.js";
import {
  PreviewConfigurationInputSchema,
  ExtendedPreviewResult,
} from "../../contracts/index.js";
import { ExecutionConfig, ExecutionConfigSchema } from "../../profile/schema.js";
import { validateExecutionConfigAgainstJsonSchema } from "../../profile/validator.js";

export { PreviewConfigurationInputSchema, ExtendedPreviewResult };

export async function handlePreviewConfiguration(
  params: { config: unknown; workspace?: string; host_id?: string },
  context: ToolContext
): Promise<ExtendedPreviewResult> {
  // Fail-closed validation against canonical JSON Schema
  const jsonValidation = validateExecutionConfigAgainstJsonSchema(params.config);
  if (!jsonValidation.valid) {
    throw new Error(
      `Execution config failed canonical schema validation:\n${jsonValidation.errors?.join("\n")}`
    );
  }

  // Parse strictly with ExecutionConfigSchema (Zod) to ensure type safety
  const validatedConfig: ExecutionConfig = ExecutionConfigSchema.parse(params.config);

  const workspace = path.resolve(params.workspace || process.cwd());
  const adapter = await context.adapterRegistry.resolveAdapter(
    workspace,
    params.host_id
  );

  const profile = await context.profileStore.getProfile(adapter.id, workspace);

  // Adapters are passed validatedConfig (strongly typed ExecutionConfig), never unchecked 'as any'
  const renderFn = adapter.previewConfiguration
    ? adapter.previewConfiguration.bind(adapter)
    : adapter.renderConfiguration?.bind(adapter);
  if (!renderFn) {
    throw new Error(
      `Adapter ${adapter.id} does not support previewConfiguration or renderConfiguration.`
    );
  }

  const renderResult = await renderFn(
    validatedConfig,
    profile || undefined,
    workspace
  );

  // Register the preview in PreviewManager to snapshot target hashes and guard apply
  const stored = await context.previewManager.createPreview(
    workspace,
    renderResult,
    validatedConfig
  );

  return {
    ...renderResult,
    preview_id: stored.preview_id,
    preview_hash: stored.preview_hash,
    diff: stored.diff,
    expires_at: stored.expires_at || "",
    target: stored.target,
    baseline_hash: stored.baseline_hash,
    mutation_targets: stored.mutation_targets,
    target_hashes: stored.target_hashes,
  };
}

export function registerPreviewConfigurationTool(
  server: McpServer,
  context: ToolContext
): void {
  server.registerTool(
    "preview_configuration",
    {
      description:
        "Generate a configuration preview (diff and mutation targets) before applying any changes.",
      inputSchema: PreviewConfigurationInputSchema,
    },
    async (params) => {
      try {
        const result = await handlePreviewConfiguration(params, context);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [
            { type: "text", text: `preview_configuration error: ${err.message}` },
          ],
        };
      }
    }
  );
}
