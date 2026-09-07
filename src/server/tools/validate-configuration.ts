import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ToolContext } from "./context.js";
import { validateExecutionConfigAgainstJsonSchema } from "../../profile/validator.js";
import {
  ValidateConfigurationInputSchema,
  ValidateConfigurationOutputSchema,
  ValidateConfigurationResult,
} from "../../contracts/index.js";

export {
  ValidateConfigurationInputSchema,
  ValidateConfigurationOutputSchema,
  ValidateConfigurationResult,
};

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
  let expected = params.expected_config;
  let adapterId = params.host_id;
  if (params.preview_id !== undefined) {
    const preview = context.previewManager.getPreview(params.preview_id);
    if (!preview) {
      throw new Error("Unknown preview_id. Supply an existing preview or an explicit expected_config.");
    }
    if (preview.workspace !== workspace) throw new Error("Preview workspace mismatch.");
    if (params.host_id && params.host_id !== preview.host_identity && params.host_id !== preview.adapter_id) {
      throw new Error("Preview host mismatch.");
    }
    adapterId = preview.adapter_id;
    expected ??= preview.config;
  }
  const validation = validateExecutionConfigAgainstJsonSchema(expected);
  if (!validation.valid) {
    throw new Error(`A canonical expected_config or existing preview_id is required: ${validation.errors?.join("; ")}`);
  }
  const adapter = params.preview_id !== undefined
    ? context.adapterRegistry.getAdapter(adapterId!)
    : await context.adapterRegistry.resolveAdapter(workspace, adapterId);
  if (!adapter) throw new Error("Preview adapter is no longer available.");

  const validationResult = await adapter.validateConfiguration(
    expected as any,
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
    details: validationResult.errors ? { errors: validationResult.errors } : validationResult.details,
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
      outputSchema: ValidateConfigurationOutputSchema,
    },
    async (params) => {
      try {
        const result = await handleValidateConfiguration(params, context);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result as any,
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
