import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ToolContext } from "./context.js";
import {
  ValidateConfigurationInputSchema,
  ValidateConfigurationResult,
} from "../../contracts/index.js";

export { ValidateConfigurationInputSchema, ValidateConfigurationResult };

export async function handleValidateConfiguration(
  params: {
    expected_config?: unknown;
    preview_id?: string;
    workspace?: string;
    host_id?: string;
  },
  context: ToolContext
): Promise<ValidateConfigurationResult> {
  const workspace = path.resolve(params.workspace || process.cwd());
  const adapter = await context.adapterRegistry.resolveAdapter(
    workspace,
    params.host_id
  );

  let expected = params.expected_config;
  if (!expected && params.preview_id) {
    const preview = context.previewManager.getPreview(params.preview_id);
    if (preview) {
      expected = preview.config;
    }
  }

  const validationResult = await adapter.validateConfiguration(
    (expected as any) || {},
    workspace
  );

  return {
    valid: validationResult.valid,
    workspace,
    message:
      validationResult.message ||
      (validationResult.valid
        ? "Actual host configuration matches expected state."
        : "Actual host configuration does not match expected state."),
    details: validationResult.errors || validationResult.details,
  };
}

export function registerValidateConfigurationTool(
  server: McpServer,
  context: ToolContext
): void {
  server.registerTool(
    "validate_configuration",
    {
      description:
        "Verify that actual host configuration matches expected configuration after apply.",
      inputSchema: ValidateConfigurationInputSchema,
    },
    async (params) => {
      try {
        const result = await handleValidateConfiguration(params, context);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [
            { type: "text", text: `validate_configuration error: ${err.message}` },
          ],
        };
      }
    }
  );
}
