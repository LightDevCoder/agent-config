import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  inspectCompanionSetup,
  previewCompanionSetup,
  applyCompanionSetup,
  validateCompanionSetup,
  runCompanionSetupLifecycle,
  formatMutationOwnership,
  runSetupCli,
  createServer,
  AdapterRegistry,
  ProfileStore,
  PreviewManager,
  CANONICAL_TOOL_CONTRACTS,
  TOOL_NAMES,
} from "../src/index.js";
import { createIsolatedEnv, IsolatedEnv } from "./harness/isolated-env.js";

describe("Cross-Harness Companion Setup & Safe Mutation Lifecycle (SPEC §13, §14, §15, §19, §71, §72, §73, §76)", () => {
  let env: IsolatedEnv;
  let workspaceDir: string;
  let adapterRegistry: AdapterRegistry;

  beforeEach(async () => {
    env = createIsolatedEnv();
    env.activate();
    workspaceDir = env.workspaceDir;
    adapterRegistry = new AdapterRegistry();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await env.cleanup();
  });

  // ==========================================================================
  // Section 1: Native Adapters Setup Lifecycle
  // ==========================================================================
  describe("Native Adapters Lifecycle: Detect, Preview, Approve, Apply, Validate", () => {
    interface AdapterTestCase {
      id: string;
      name: string;
      setupWorkspace: (dir: string) => Promise<void>;
      expectedTargetSubpath: string;
    }

    const NATIVE_ADAPTERS: AdapterTestCase[] = [
      {
        id: "codex",
        name: "Codex",
        setupWorkspace: async (dir) => {
          await fsp.mkdir(path.join(dir, ".codex"), { recursive: true });
        },
        expectedTargetSubpath: path.join(".codex", "config.toml"),
      },
      {
        id: "opencode",
        name: "OpenCode",
        setupWorkspace: async (dir) => {
          await fsp.writeFile(path.join(dir, "opencode.json"), "{}", "utf-8");
        },
        expectedTargetSubpath: "opencode.json",
      },
      {
        id: "claude-code",
        name: "Claude Code",
        setupWorkspace: async (dir) => {
          await fsp.mkdir(path.join(dir, ".claude"), { recursive: true });
        },
        expectedTargetSubpath: ".mcp.json",
      },
      {
        id: "gemini-cli",
        name: "Gemini CLI",
        setupWorkspace: async (dir) => {
          await fsp.mkdir(path.join(dir, ".gemini"), { recursive: true });
        },
        expectedTargetSubpath: path.join(".gemini", "config.json"),
      },
      {
        id: "cursor",
        name: "Cursor",
        setupWorkspace: async (dir) => {
          await fsp.mkdir(path.join(dir, ".cursor"), { recursive: true });
        },
        expectedTargetSubpath: path.join(".cursor", "mcp.json"),
      },
      {
        id: "dsh",
        name: "DeepSeek Harness (DSH)",
        setupWorkspace: async (dir) => {
          await fsp.mkdir(path.join(dir, ".dsh"), { recursive: true });
          // Version safety marker per SPEC §42
          await fsp.writeFile(path.join(dir, ".dsh", "version"), "1.0.0\n", "utf-8");
        },
        expectedTargetSubpath: "cordis.patch.yml",
      },
      {
        id: "grok-build",
        name: "Grok Build",
        setupWorkspace: async (dir) => {
          await fsp.mkdir(path.join(dir, ".grok"), { recursive: true });
        },
        expectedTargetSubpath: path.join(".grok", "config.toml"),
      },
      {
        id: "pi",
        name: "Pi Coding Agent",
        setupWorkspace: async (dir) => {
          const globalPi = path.join(os.homedir(), ".pi", "agent");
          await fsp.mkdir(globalPi, { recursive: true });
          await fsp.writeFile(path.join(globalPi, "settings.json"), '{"defaultProjectTrust":"always"}');
          const piDir = path.join(dir, ".pi");
          const extension = path.join(piDir, "npm", "node_modules", "pi-mcp-adapter");
          await fsp.mkdir(extension, { recursive: true });
          await fsp.writeFile(path.join(extension, "package.json"), '{"name":"pi-mcp-adapter"}');
          await fsp.writeFile(path.join(piDir, "settings.json"), '{"packages":["npm:pi-mcp-adapter"]}');
          vi.spyOn(adapterRegistry.getAdapter("pi")!, "inspectVersion").mockResolvedValue({
            version: "0.85.1", compatibility: "supported", fail_closed_for_mutation: false,
          });
        },
        expectedTargetSubpath: path.join(".pi", "mcp.json"),
      },
    ];

    for (const { id, name, setupWorkspace, expectedTargetSubpath } of NATIVE_ADAPTERS) {
      describe(`${name} (${id})`, () => {
        beforeEach(async () => {
          await setupWorkspace(workspaceDir);
        });

        it("1. Detection: identifies unregistered state without silent mutation", async () => {
          const snapshotBefore = env.snapshotDirectory(workspaceDir);

          const inspection = await inspectCompanionSetup({
            workspace: workspaceDir,
            host_id: id,
            registry: adapterRegistry,
          });

          expect(inspection.adapter_id).toBe(id);
          expect(inspection.host_id).toBe(id);
          expect(inspection.registered).toBe(false);
          expect(inspection.scope).toBe("project");
          expect(inspection.target_file).toBeDefined();
          expect(inspection.target_file).toContain(expectedTargetSubpath);

          // Invariant: Detection != Mutation
          env.assertDirectoryUnchanged(workspaceDir, snapshotBefore, `${name} inspectCompanionSetup`);
        });

        it("2. Preview: generates exact ownership and unified diff without mutating", async () => {
          const snapshotBefore = env.snapshotDirectory(workspaceDir);

          const preview = await previewCompanionSetup({
            workspace: workspaceDir,
            host_id: id,
            registry: adapterRegistry,
          });

          expect(preview.supported).toBe(true);
          expect(preview.adapter_id).toBe(id);
          expect(preview.host_id).toBe(id);
          expect(preview.scope).toBe("project");
          expect(preview.target_file).toContain(expectedTargetSubpath);
          expect(preview.preview_hash).toBeDefined();
          expect(preview.preview_hash.length).toBe(64); // SHA-256
          expect(preview.diff).toContain("agent-config");

          // Mutation Ownership (§72)
          expect(preview.ownership.adapter).toBe(id);
          expect(preview.ownership.host).toBe(id);
          expect(preview.ownership.scope).toBe("project");
          expect(preview.ownership.target).toContain(expectedTargetSubpath);
          expect(preview.ownership.changes).toBe(preview.diff);
          expect(preview.formatted_ownership).toContain("Mutation Ownership:");
          expect(preview.formatted_ownership).toContain(id);

          // Invariant: Detection != Mutation
          env.assertDirectoryUnchanged(workspaceDir, snapshotBefore, `${name} previewCompanionSetup`);
        });

        it("3. Approval Requirement: rejects apply when explicit approval is false", async () => {
          const preview = await previewCompanionSetup({
            workspace: workspaceDir,
            host_id: id,
            registry: adapterRegistry,
          });

          const snapshotBefore = env.snapshotDirectory(workspaceDir);

          const unapprovedApply = await applyCompanionSetup({
            workspace: workspaceDir,
            host_id: id,
            preview_id: preview.preview_id,
            preview_hash: preview.preview_hash,
            baseline_hash: preview.baseline_hash,
            explicit_approval: false, // Refused!
            registry: adapterRegistry,
          });

          expect(unapprovedApply.success).toBe(false);
          expect(unapprovedApply.error).toContain("ApprovalRequiredError");

          // Filesystem untouched
          env.assertDirectoryUnchanged(workspaceDir, snapshotBefore, `${name} unapproved apply`);
        });

        it("4. Apply & Validation: applies atomically and validates effective host state", async () => {
          const preview = await previewCompanionSetup({
            workspace: workspaceDir,
            host_id: id,
            registry: adapterRegistry,
          });

          // Apply with explicit approval
          const applyResult = await applyCompanionSetup({
            workspace: workspaceDir,
            host_id: id,
            preview_id: preview.preview_id,
            preview_hash: preview.preview_hash,
            baseline_hash: preview.baseline_hash,
            explicit_approval: true,
            registry: adapterRegistry,
          });

          expect(applyResult.success).toBe(true);
          expect(applyResult.applied_targets.length).toBeGreaterThan(0);
          expect(applyResult.validation?.valid).toBe(true);

          // Read back effective host state (§14, §73, §76)
          const postInspection = await inspectCompanionSetup({
            workspace: workspaceDir,
            host_id: id,
            registry: adapterRegistry,
          });

          expect(postInspection.registered).toBe(true);
          expect(postInspection.command).toBeDefined();

          // Validation step
          const validation = await validateCompanionSetup({
            workspace: workspaceDir,
            host_id: id,
            registry: adapterRegistry,
          });

          expect(validation.valid).toBe(true);
          expect(validation.registered).toBe(true);
          expect(validation.mcp_reachable).toBe(false);
          expect(validation.healthy).toBe(false);
          expect(validation.semantic_config_valid).toBe(true);
        });
      });
    }
  });

  // ==========================================================================
  // Section 2: Concurrency & Baseline Drift Safety (§71)
  // ==========================================================================
  describe("Baseline Hash & Concurrent Drift Safety", () => {
    it("rejects apply when target configuration drifts between preview and apply", async () => {
      await fsp.writeFile(path.join(workspaceDir, "opencode.json"), "{}", "utf-8");

      const preview = await previewCompanionSetup({
        workspace: workspaceDir,
        host_id: "opencode",
        registry: adapterRegistry,
      });

      // Concurrent modification occurs before user approval!
      await fsp.writeFile(
        path.join(workspaceDir, "opencode.json"),
        JSON.stringify({ model: "concurrent-drift-model" }),
        "utf-8"
      );

      // Attempt apply with original baseline hash
      const driftedApply = await applyCompanionSetup({
        workspace: workspaceDir,
        host_id: "opencode",
        preview_id: preview.preview_id,
        preview_hash: preview.preview_hash,
        baseline_hash: preview.baseline_hash,
        explicit_approval: true,
        registry: adapterRegistry,
      });

      expect(driftedApply.success).toBe(false);
      expect(driftedApply.error).toContain("BaselineDriftError");
    });

    it("distinguishes registered vs reachable in companion inspection and rejects reachable without verified command or doctor (SPEC §32-§33)", async () => {
      // Create an empty MCP configuration for openCode with a non-existent / unreachable command
      await fsp.mkdir(path.join(workspaceDir, ".opencode"), { recursive: true });
      const opencodeJsonPath = path.join(workspaceDir, ".opencode", "opencode.json");
      await fsp.writeFile(
        opencodeJsonPath,
        JSON.stringify({
          mcp: {
            servers: {
              "agent-config": {
                command: "/nonexistent/binary/path/which_does_not_exist",
                args: [],
              },
            },
          },
        }),
        "utf-8"
      );

      const inspection = await inspectCompanionSetup({
        workspace: workspaceDir,
        host_id: "opencode",
        registry: adapterRegistry,
      });

      expect(inspection.registered).toBe(true);

      const validation = await validateCompanionSetup({
        workspace: workspaceDir,
        host_id: "opencode",
        registry: adapterRegistry,
      });

      // Entry is registered and configured, but command does not exist -> reachable must be false!
      expect(validation.registered).toBe(true);
      expect(validation.configured).toBe(true);
      expect(validation.reachable).toBe(false);
      expect(validation.healthy).toBe(false);
      expect(validation.mcp_reachable).toBe(false);
    });

    it("rejects apply when frozen preview host version drifts before apply (SPEC §31)", async () => {
      await fsp.writeFile(path.join(workspaceDir, "opencode.json"), "{}", "utf-8");

      const preview = await previewCompanionSetup({
        workspace: workspaceDir,
        host_id: "opencode",
        registry: adapterRegistry,
      });

      // Modify preview version to simulate host version drift
      preview.host_version = "99.99.99-drifted";

      const driftedVersionApply = await applyCompanionSetup({
        workspace: workspaceDir,
        host_id: "opencode",
        preview_id: preview.preview_id,
        preview_hash: preview.preview_hash,
        baseline_hash: preview.baseline_hash,
        explicit_approval: true,
        registry: adapterRegistry,
        frozen_preview: preview,
      });

      expect(driftedVersionApply.success).toBe(false);
      expect(driftedVersionApply.error).toContain("StalePreviewError");
    });
  });

  // ==========================================================================
  // Section 3: Generic Adapter Plan-Only Fail-Closed Behavior
  // ==========================================================================
  describe("Generic Adapter Plan-Only Fail-Closed Behavior", () => {
    it("reports unregistered and unsupported for mutation without mutating", async () => {
      // Empty workspace resolves to Generic adapter
      const inspection = await inspectCompanionSetup({
        workspace: workspaceDir,
        host_id: "generic",
        registry: adapterRegistry,
      });
      expect(inspection.registered).toBe(false);

      const preview = await previewCompanionSetup({
        workspace: workspaceDir,
        host_id: "generic",
        registry: adapterRegistry,
      });
      expect(preview.supported).toBe(false);

      const apply = await applyCompanionSetup({
        workspace: workspaceDir,
        host_id: "generic",
        preview_hash: "bogus-hash",
        explicit_approval: true,
        registry: adapterRegistry,
      });
      expect(apply.success).toBe(false);
    });
  });

  // ==========================================================================
  // Section 4: Unified Lifecycle Coordinator (`runCompanionSetupLifecycle`)
  // ==========================================================================
  describe("Unified Lifecycle Coordinator", () => {
    it("pauses at preview stage waiting for approval when explicit_approval is omitted", async () => {
      await fsp.mkdir(path.join(workspaceDir, ".codex"), { recursive: true });

      const result = await runCompanionSetupLifecycle({
        workspace: workspaceDir,
        host_id: "codex",
        registry: adapterRegistry,
      });

      expect(result.stage).toBe("preview");
      expect(result.requires_approval).toBe(true);
      expect(result.preview).toBeDefined();
      expect(result.apply).toBeUndefined();

      // Verify no target file was written
      const targetFile = path.join(workspaceDir, ".codex", "config.toml");
      expect(fs.existsSync(targetFile)).toBe(false);
    });

    function getCanonicalTools() {
      return TOOL_NAMES.map((name) => {
        const canonical = CANONICAL_TOOL_CONTRACTS[name];
        return {
          name: canonical.name,
          description: canonical.description,
          parameters: canonical.parameters,
          requiredParameters: canonical.requiredParameters,
          responseProperties: canonical.responseProperties,
          requiredResponseProperties: canonical.requiredResponseProperties,
        };
      });
    }

    it("completes full lifecycle when explicit_approval is true and companion is healthy", async () => {
      await fsp.mkdir(path.join(workspaceDir, ".codex"), { recursive: true });

      const result = await runCompanionSetupLifecycle({
        workspace: workspaceDir,
        host_id: "codex",
        explicit_approval: true,
        registry: adapterRegistry,
        reachable: true,
        tools: getCanonicalTools(),
        protocol_version: 1,
      });

      expect(result.stage).toBe("completed");
      expect(result.apply?.success).toBe(true);
      expect(result.validation?.valid).toBe(true);

      // Verify target file exists and is registered
      const targetFile = path.join(workspaceDir, ".codex", "config.toml");
      expect(fs.existsSync(targetFile)).toBe(true);

      // Re-running lifecycle returns completed immediately
      const rerun = await runCompanionSetupLifecycle({
        workspace: workspaceDir,
        host_id: "codex",
        registry: adapterRegistry,
        reachable: true,
        tools: getCanonicalTools(),
        protocol_version: 1,
      });
      expect(rerun.stage).toBe("completed");
      expect(rerun.inspection.registered).toBe(true);
    });

    it("returns repair_required and success: false when registered but companion is unhealthy (SPEC §10, §14 Scenario G)", async () => {
      await fsp.mkdir(path.join(workspaceDir, ".codex"), { recursive: true });

      const result = await runCompanionSetupLifecycle({
        workspace: workspaceDir,
        host_id: "codex",
        explicit_approval: true,
        registry: adapterRegistry,
        // No companion running -> unhealthy
      });

      expect(result.stage).toBe("repair_required");
      expect(result.success).toBe(false);
      expect(result.apply?.applied_targets.length).toBeGreaterThan(0);
      expect(result.message).not.toContain("registered and validated");
    });
  });

  // ==========================================================================
  // Section 5: CLI Setup Runner (`runSetupCli`)
  // ==========================================================================
  describe("CLI Setup Runner (agent-config setup)", () => {
    it("executes --check returning 1 on unregistered and 1 on registered but unreachable (healthy: false)", async () => {
      await fsp.mkdir(path.join(workspaceDir, ".cursor"), { recursive: true });

      const checkUnregistered = await runSetupCli([
        "--workspace",
        workspaceDir,
        "--host",
        "cursor",
        "--check",
      ]);
      expect(checkUnregistered).toBe(1);

      // Apply with --yes
      const applyResult = await runSetupCli([
        "--workspace",
        workspaceDir,
        "--host",
        "cursor",
        "--apply",
        "--yes",
      ]);
      expect(applyResult).toBe(0);

      // Registered but process is unreachable -> must return 1 and NOT fake healthy! (SPEC §5, §6)
      const checkRegistered = await runSetupCli([
        "--workspace",
        workspaceDir,
        "--host",
        "cursor",
        "--check",
      ]);
      expect(checkRegistered).toBe(1);
    });

    it("refuses to apply mutation without --yes flag", async () => {
      await fsp.mkdir(path.join(workspaceDir, ".cursor"), { recursive: true });

      const snapshotBefore = env.snapshotDirectory(workspaceDir);

      const applyWithoutYes = await runSetupCli([
        "--workspace",
        workspaceDir,
        "--host",
        "cursor",
        "--apply", // missing --yes
      ]);
      expect(applyWithoutYes).toBe(1);

      env.assertDirectoryUnchanged(workspaceDir, snapshotBefore, "CLI unapproved apply");
    });
  });

  // ==========================================================================
  // Section 6: Dedicated Companion Setup MCP Tools
  // ==========================================================================
  describe("Dedicated Companion Setup MCP Tools", () => {
    let client: Client;
    let server: ReturnType<typeof createServer>;

    beforeEach(async () => {
      await fsp.mkdir(path.join(workspaceDir, ".cursor"), { recursive: true });

      server = createServer({
        profileStore: new ProfileStore(),
        adapterRegistry,
        previewManager: new PreviewManager(),
        includeSetupTools: true, // Enable setup tools
      });

      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      client = new Client({ name: "setup-mcp-test-client", version: "1.0.0" });
      await Promise.all([
        client.connect(clientTransport),
        server.connect(serverTransport),
      ]);
    });

    afterEach(async () => {
    vi.restoreAllMocks();
      await client.close();
      await server.close();
    });

    it("registers companion setup tools and executes inspection, preview, approval, and apply", async () => {
      const toolsResult = await client.listTools();
      const toolNames = toolsResult.tools.map((t) => t.name);

      expect(toolNames).toContain("inspect_companion_setup");
      expect(toolNames).toContain("preview_companion_setup");
      expect(toolNames).toContain("apply_companion_setup");
      expect(toolNames).toContain("validate_companion_setup");

      // 1. inspect_companion_setup
      const inspectRes = await client.callTool({
        name: "inspect_companion_setup",
        arguments: { workspace: workspaceDir, host_id: "cursor" },
      });
      const inspectData = JSON.parse((inspectRes.content[0] as { type: string; text: string }).text);
      expect(inspectData.registered).toBe(false);

      // 2. preview_companion_setup
      const previewRes = await client.callTool({
        name: "preview_companion_setup",
        arguments: { workspace: workspaceDir, host_id: "cursor" },
      });
      const previewData = JSON.parse((previewRes.content[0] as { type: string; text: string }).text);
      expect(previewData.supported).toBe(true);
      expect(previewData.ownership.adapter).toBe("cursor");

      // 3. apply_companion_setup without explicit approval
      const unapprovedRes = await client.callTool({
        name: "apply_companion_setup",
        arguments: {
          preview_hash: previewData.preview_hash,
          explicit_approval: false,
          workspace: workspaceDir,
          host_id: "cursor",
        },
      });
      const unapprovedData = JSON.parse((unapprovedRes.content[0] as { type: string; text: string }).text);
      expect(unapprovedData.success).toBe(false);

      // 4. apply_companion_setup with explicit approval
      const applyRes = await client.callTool({
        name: "apply_companion_setup",
        arguments: {
          preview_hash: previewData.preview_hash,
          explicit_approval: true,
          workspace: workspaceDir,
          host_id: "cursor",
        },
      });
      const applyData = JSON.parse((applyRes.content[0] as { type: string; text: string }).text);
      expect(applyData.success).toBe(true);
      expect(applyData.validation.valid).toBe(true);

      // 5. validate_companion_setup
      const validateRes = await client.callTool({
        name: "validate_companion_setup",
        arguments: { workspace: workspaceDir, host_id: "cursor" },
      });
      const validateData = JSON.parse((validateRes.content[0] as { type: string; text: string }).text);
      expect(validateData.valid).toBe(true);
      expect(validateData.registered).toBe(true);
      expect(validateData.mcp_reachable).toBe(false);
      expect(validateData.healthy).toBe(false);
    });

    it("preserves standard 8 tools when includeSetupTools is not set", async () => {
      const standardServer = createServer();
      const [cTransport, sTransport] = InMemoryTransport.createLinkedPair();
      const stdClient = new Client({ name: "standard-client", version: "1.0.0" });
      await Promise.all([
        stdClient.connect(cTransport),
        standardServer.connect(sTransport),
      ]);

      const toolsResult = await stdClient.listTools();
      expect(toolsResult.tools).toHaveLength(8);

      await stdClient.close();
      await standardServer.close();
    });
  });
});
