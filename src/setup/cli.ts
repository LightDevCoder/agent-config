import path from "node:path";
import {
  inspectCompanionSetup,
  previewCompanionSetup,
  applyCompanionSetup,
  validateCompanionSetup,
  runCompanionSetupLifecycle,
  formatMutationOwnership,
} from "./lifecycle.js";
import { defaultAdapterRegistry } from "../adapters/registry.js";

export interface SetupCliOptions {
  workspace?: string;
  host_id?: string;
  scope?: "project" | "global";
  checkOnly?: boolean;
  previewOnly?: boolean;
  apply?: boolean;
  explicitApproval?: boolean;
  json?: boolean;
}

export function parseCliArgs(args: string[]): SetupCliOptions {
  const options: SetupCliOptions = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--workspace" && i + 1 < args.length) {
      options.workspace = args[++i];
    } else if (arg.startsWith("--workspace=")) {
      options.workspace = arg.slice("--workspace=".length);
    } else if (arg === "--host" && i + 1 < args.length) {
      options.host_id = args[++i];
    } else if (arg.startsWith("--host=")) {
      options.host_id = arg.slice("--host=".length);
    } else if (arg === "--scope" && i + 1 < args.length) {
      const s = args[++i];
      if (s === "project" || s === "global") options.scope = s;
    } else if (arg.startsWith("--scope=")) {
      const s = arg.slice("--scope=".length);
      if (s === "project" || s === "global") options.scope = s;
    } else if (arg === "--check" || arg === "--inspect") {
      options.checkOnly = true;
    } else if (arg === "--preview") {
      options.previewOnly = true;
    } else if (arg === "--apply") {
      options.apply = true;
    } else if (arg === "--yes" || arg === "-y" || arg === "--approve") {
      options.explicitApproval = true;
    } else if (arg === "--json") {
      options.json = true;
    }
  }

  return options;
}

/**
 * CLI command runner for `agent-config setup` (§13, §14, §15, §71).
 */
export async function runSetupCli(args: string[]): Promise<number> {
  const options = parseCliArgs(args);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Agent Config Companion Setup

Usage:
  agent-config setup [options]

Options:
  --workspace <path>     Workspace root path (defaults to current working directory)
  --host <host_id>       Target harness host ID (auto-detected if omitted)
  --scope <type>         Configuration scope: 'project' (default) or 'global'
  --check, --inspect     Only inspect companion registration status (read-only)
  --preview              Generate preview diff and mutation ownership (read-only)
  --apply                Apply companion registration (requires --yes)
  --yes, -y, --approve   Grant explicit approval for mutation
  --json                 Output result in JSON format
  -h, --help             Display this help message
`);
    return 0;
  }

  try {
    // 1. Inspect and verify authentic companion health (§5, §6)
    if (options.checkOnly) {
      const inspection = await inspectCompanionSetup({
        workspace: options.workspace,
        host_id: options.host_id,
        scope: options.scope,
      });

      if (!inspection.registered) {
        if (options.json) {
          console.log(
            JSON.stringify(
              {
                registered: false,
                configured: false,
                reachable: false,
                healthy: false,
                host_id: inspection.host_id,
                adapter_id: inspection.adapter_id,
                message: `Companion MCP is not registered for host '${inspection.host_id}'.`,
              },
              null,
              2
            )
          );
        } else {
          console.log(`Harness:    ${inspection.host_id} (Adapter: ${inspection.adapter_id})`);
          console.log(`Registered: NO`);
        }
        return 1;
      }

      const validation = await validateCompanionSetup({
        workspace: options.workspace,
        host_id: options.host_id,
        scope: options.scope,
      });

      if (options.json) {
        console.log(
          JSON.stringify(
            {
              inspection,
              validation,
              registered: validation.registered,
              configured: validation.configured,
              reachable: validation.reachable,
              healthy: validation.healthy,
            },
            null,
            2
          )
        );
      } else {
        console.log(`Harness:    ${inspection.host_id} (Adapter: ${inspection.adapter_id})`);
        console.log(`Registered: ${validation.registered ? "YES" : "NO"}`);
        console.log(`Configured: ${validation.configured ? "YES" : "NO"}`);
        console.log(`Reachable:  ${validation.reachable ? "YES" : "NO"}`);
        console.log(`Healthy:    ${validation.healthy ? "YES" : "NO"}`);
        if (inspection.locator) {
          console.log(`Locator:    ${inspection.locator}`);
        }
        if (validation.health?.missing_tools && validation.health.missing_tools.length > 0) {
          console.log(`Missing tools: ${validation.health.missing_tools.join(", ")}`);
        }
        if (validation.health?.schema_errors && validation.health.schema_errors.length > 0) {
          console.log(`Schema errors: ${validation.health.schema_errors.join("; ")}`);
        }
      }
      return validation.healthy ? 0 : 1;
    }

    // 2. Full lifecycle or preview/apply
    const inspection = await inspectCompanionSetup({
      workspace: options.workspace,
      host_id: options.host_id,
      scope: options.scope,
    });

    if (inspection.registered && !options.previewOnly && !options.apply) {
      const validation = await validateCompanionSetup({
        workspace: options.workspace,
        host_id: options.host_id,
        scope: options.scope,
      });

      if (options.json) {
        console.log(JSON.stringify({ inspection, validation }, null, 2));
      } else {
        console.log(`Agent Config Companion MCP is already registered for ${inspection.host_id}.`);
        console.log(`Locator:    ${inspection.locator}`);
        console.log(`Validation: ${validation.valid ? "PASSED" : "FAILED"}`);
        if (!validation.valid) {
          console.error(`Reason:     ${validation.message}`);
          return 1;
        }
      }
      return 0;
    }

    // Generate preview
    const preview = await previewCompanionSetup({
      workspace: options.workspace,
      host_id: options.host_id,
      scope: options.scope,
    });

    if (!preview.supported) {
      if (options.json) {
        console.log(JSON.stringify({ error: preview.error || "Unsupported host" }, null, 2));
      } else {
        console.error(`Companion setup unsupported for ${preview.host_id}: ${preview.error}`);
      }
      return 1;
    }

    if (!options.apply) {
      // Preview mode
      if (options.json) {
        console.log(JSON.stringify(preview, null, 2));
      } else {
        console.log(preview.formatted_ownership);
        console.log("\nTo apply this mutation, run with --apply --yes");
      }
      return 0;
    }

    // Apply requested: enforce explicit approval
    if (!options.explicitApproval) {
      console.error("Error: Explicit user approval required (--yes) before applying mutation.");
      console.error(preview.formatted_ownership);
      return 1;
    }

    const applyResult = await applyCompanionSetup({
      workspace: options.workspace,
      host_id: options.host_id,
      scope: options.scope,
      preview_id: preview.preview_id,
      preview_hash: preview.preview_hash,
      baseline_hash: preview.baseline_hash,
      explicit_approval: true,
    });

    if (options.json) {
      console.log(JSON.stringify(applyResult, null, 2));
    } else {
      console.log(applyResult.message);
      if (applyResult.validation) {
        console.log(`Validation: ${applyResult.validation.valid ? "PASSED" : "FAILED"}`);
      }
    }

    return applyResult.success ? 0 : 1;
  } catch (err: any) {
    console.error(`Setup error: ${err.message}`);
    return 1;
  }
}
