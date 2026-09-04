import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ToolContext } from "./context.js";
import { ConfigurationRenderResult } from "../../adapters/contract.js";

export const PreviewConfigurationInputSchema = {
  config: z
    .record(z.any())
    .describe("Execution configuration or settings to render and preview"),
  workspace: z
    .string()
    .optional()
    .describe("Workspace directory path (defaults to current working directory)"),
  host_id: z
    .string()
    .optional()
    .describe("Host identifier (optional, auto-detected from adapter if omitted)"),
};

export interface ExtendedPreviewResult extends ConfigurationRenderResult {
  preview_hash: string;
  expires_at: string;
}

export async function handlePreviewConfiguration(
  params: { config: unknown; workspace?: string; host_id?: string },
  context: ToolContext
): Promise<ExtendedPreviewResult> {
  const workspace = path.resolve(params.workspace || process.cwd());
  const adapter = await context.adapterRegistry.resolveAdapter(
    workspace,
    params.host_id
  );

  const profile = await context.profileStore.getProfile(adapter.id, workspace);

  const renderResult = await adapter.renderConfiguration(
    params.config as any,
    profile || undefined,
    workspace
  );

  // Register the preview in PreviewManager to snapshot target hashes and guard apply
  const stored = await context.previewManager.createPreview(
    workspace,
    renderResult,
    params.config
  );

  return {
    ...renderResult,
    preview_hash: stored.preview_hash,
    expires_at: stored.expires_at || "",
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
