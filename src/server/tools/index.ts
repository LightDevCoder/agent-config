import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ToolContext } from "./context.js";
import { registerGetSetupStatusTool } from "./get-setup-status.js";
import { registerInspectHostTool } from "./inspect-host.js";
import { registerGetProfileTool } from "./get-profile.js";
import { registerSaveProfileTool } from "./save-profile.js";
import { registerPreviewConfigurationTool } from "./preview-configuration.js";
import { registerApplyConfigurationTool } from "./apply-configuration.js";
import { registerValidateConfigurationTool } from "./validate-configuration.js";
import { registerResetProfileTool } from "./reset-profile.js";

export * from "./context.js";
export * from "./get-setup-status.js";
export * from "./inspect-host.js";
export * from "./get-profile.js";
export * from "./save-profile.js";
export * from "./preview-configuration.js";
export * from "./apply-configuration.js";
export * from "./validate-configuration.js";
export * from "./reset-profile.js";

/**
 * Registers all eight canonical Agent Config tools on the provided McpServer.
 */
export function registerAllTools(server: McpServer, context: ToolContext): void {
  registerGetSetupStatusTool(server, context);
  registerInspectHostTool(server, context);
  registerGetProfileTool(server, context);
  registerSaveProfileTool(server, context);
  registerPreviewConfigurationTool(server, context);
  registerApplyConfigurationTool(server, context);
  registerValidateConfigurationTool(server, context);
  registerResetProfileTool(server, context);
}
