import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ToolContext } from "./context.js";
import {
  ApplyConfigurationInputSchema,
  ApplyConfigurationResult,
} from "../../contracts/index.js";

export { ApplyConfigurationInputSchema, ApplyConfigurationResult };

export async function handleApplyConfiguration(
  params: { preview_id: string; workspace?: string },
  context: ToolContext
): Promise<ApplyConfigurationResult> {
  const workspace = path.resolve(params.workspace || process.cwd());

  // 1. Validate preview existence, target hashes, and applied state
  const validation = await context.previewManager.validatePreview(
    params.preview_id,
    workspace
  );

  if (!validation.valid || !validation.preview) {
    throw new Error(
      `Cannot apply configuration: ${validation.error || "Invalid preview"}`
    );
  }

  const preview = validation.preview;

  // 2. Resolve adapter for the target workspace
  const adapter = await context.adapterRegistry.resolveAdapter(workspace);

  // 3. Apply via adapter
  const applyResult = await adapter.applyConfiguration(
    params.preview_id,
    preview.rendered,
    workspace
  );
  if (!applyResult.success) {
    throw new Error(
      `Adapter '${adapter.id}' failed to apply configuration for preview '${params.preview_id}': ${applyResult.error || applyResult.message || "Unknown error"}`
    );
  }

  // 4. Mark preview as applied so it cannot be reapplied
  context.previewManager.markApplied(params.preview_id);

  const appliedTargets =
    applyResult.applied_targets.length > 0
      ? applyResult.applied_targets
      : preview.mutation_targets;

  return {
    success: true,
    preview_id: params.preview_id,
    applied_targets: appliedTargets,
    target: preview.target || appliedTargets[0] || workspace,
    baseline_hash: preview.baseline_hash ?? null,
    message:
      applyResult.message ||
      `Configuration for preview '${params.preview_id}' applied successfully.`,
  };
}

export function registerApplyConfigurationTool(
  server: McpServer,
  context: ToolContext
): void {
  server.registerTool(
    "apply_configuration",
    {
      description:
        "Apply a previously previewed configuration using a valid preview ID.",
      inputSchema: ApplyConfigurationInputSchema,
    },
    async (params) => {
      try {
        const result = await handleApplyConfiguration(params, context);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [
            { type: "text", text: `apply_configuration error: ${err.message}` },
          ],
        };
      }
    }
  );
}
