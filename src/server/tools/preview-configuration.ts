import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ToolContext } from "./context.js";
import {
  PreviewConfigurationInputSchema,
  PreviewConfigurationOutputSchema,
  ExtendedPreviewResult,
} from "../../contracts/index.js";
import { ExecutionConfig, ExecutionConfigSchema } from "../../profile/schema.js";
import {
  validateExecutionConfigAgainstJsonSchema,
  validateExecutionConfig,
} from "../../profile/validator.js";

export {
  PreviewConfigurationInputSchema,
  PreviewConfigurationOutputSchema,
  ExtendedPreviewResult,
};

export async function handlePreviewConfiguration(
  params: { config: unknown; workspace?: string; host_id?: string },
  context: ToolContext
): Promise<ExtendedPreviewResult> {
  // 1. Fail-closed canonical schema validation
  const jsonValidation = validateExecutionConfigAgainstJsonSchema(params.config);
  if (!jsonValidation.valid) {
    throw new Error(
      `Execution config failed canonical schema validation:\n${jsonValidation.errors?.join("\n")}`
    );
  }

  // 2. Parse strictly with ExecutionConfigSchema (Zod) to ensure type safety
  const validatedConfig: ExecutionConfig = ExecutionConfigSchema.parse(params.config);

  const workspace = path.resolve(params.workspace || process.cwd());
  const adapter = await context.adapterRegistry.resolveAdapter(
    workspace,
    params.host_id
  );

  // 3. Resolve concrete host_id & current HostCapabilities (§20, §3, §4)
  // Unified production lookup: current Host inspection -> concrete host_id
  const hostCapabilities = await adapter.inspectCapabilities(workspace);
  const concreteHostId = params.host_id || hostCapabilities?.host_id;
  if (!concreteHostId) {
    throw new Error(
      "Unable to determine concrete host ID: host inspection did not evidence a host_id and no explicit host_id was provided."
    );
  }

  // 4. Resolve effective Profile by concrete host_id + workspace scope
  // MUST NOT look up by adapter.id when host_id != adapter_id!
  const profile = await context.profileStore.getProfile(concreteHostId, workspace);
  if (!profile) {
    throw new Error(
      `No authorized profile found for host '${concreteHostId}' at workspace '${workspace}'. A user-confirmed profile is required before configuration can be previewed.`
    );
  }

  // 5. Validate ExecutionConfig against Profile authority and Host capability intersection
  // Host defines what exists, User Profile defines what may be used, Agent Config chooses only inside intersection
  const validationResult = validateExecutionConfig(
    validatedConfig,
    profile,
    hostCapabilities
  );
  if (!validationResult.valid) {
    throw new Error(
      `Execution configuration validation failed against Profile and Host capabilities:\n${validationResult.errors?.join("\n")}`
    );
  }

  // 6. PASS -> Only now call adapter preview/render
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
    profile,
    workspace
  );

  const versionInfo = await adapter.inspectVersion(workspace);

  // Register the preview in PreviewManager to snapshot target hashes and guard apply
  const stored = await context.previewManager.createPreview(
    workspace,
    renderResult,
    validatedConfig,
    {
      adapter_id: adapter.id,
      host_identity: concreteHostId,
      host_version: versionInfo.version,
      scope: workspace ? "project" : "global",
      target: renderResult.mutation_targets[0] || workspace,
    }
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
      outputSchema: PreviewConfigurationOutputSchema,
    },
    async (params) => {
      try {
        const result = await handlePreviewConfiguration(params, context);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result as any,
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `preview_configuration error: ${err.message}`,
            },
          ],
        };
      }
    }
  );
}
