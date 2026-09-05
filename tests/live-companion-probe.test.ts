import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import { fileURLToPath } from "node:url";
import {
  validateCompanionSetup,
  runCompanionSetupLifecycle,
  previewCompanionSetup,
  applyCompanionSetup,
} from "../src/setup/lifecycle.js";
import { runSetupCli } from "../src/setup/cli.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fakeCompanionScript = path.join(__dirname, "fixtures", "fake-companion-process.js");

describe("Live Companion MCP Health Probe & Lifecycle Acceptance (SPEC §13, §14)", () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-config-probe-"));
  });

  afterEach(async () => {
    if (fs.existsSync(workspaceDir)) {
      await fsp.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  async function registerFakeCompanion(scenario: string) {
    const cursorDir = path.join(workspaceDir, ".cursor");
    await fsp.mkdir(cursorDir, { recursive: true });
    const configPath = path.join(cursorDir, "mcp.json");
    const mcpConfig = {
      mcpServers: {
        "agent-config": {
          command: process.execPath,
          args: [fakeCompanionScript, `--scenario=${scenario}`],
        },
      },
    };
    await fsp.writeFile(configPath, JSON.stringify(mcpConfig, null, 2), "utf-8");
  }

  // -------------------------------------------------------------------------
  // Scenario A: Wrong Agent Config contract version (SPEC §13 Scenario A)
  // -------------------------------------------------------------------------
  it("Scenario A: live Companion advertises protocol_version = 2 -> reachable: true, healthy: false, protocol mismatch diagnostic", async () => {
    await registerFakeCompanion("wrong-protocol");

    // Real production probe: spawns fake Companion process over stdio
    const validation = await validateCompanionSetup({
      workspace: workspaceDir,
      host_id: "cursor",
    });

    expect(validation.registered).toBe(true);
    expect(validation.reachable).toBe(true);
    expect(validation.healthy).toBe(false);
    expect(validation.health?.healthy).toBe(false);
    expect(validation.health?.protocol_version).toBe(2);
    expect(
      validation.health?.reasons.some((r) => r.includes("Protocol version mismatch: expected 1, got 2"))
    ).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Scenario B: Missing output schema (SPEC §13 Scenario B)
  // -------------------------------------------------------------------------
  it("Scenario B: live Companion is missing output schema on a tool -> healthy: false, output schema diagnostic", async () => {
    await registerFakeCompanion("missing-output-schema");

    const validation = await validateCompanionSetup({
      workspace: workspaceDir,
      host_id: "cursor",
    });

    expect(validation.registered).toBe(true);
    expect(validation.reachable).toBe(true);
    expect(validation.healthy).toBe(false);
    expect(validation.health?.healthy).toBe(false);
    expect(
      validation.health?.schema_errors.some((e) => e.includes("Tool 'save_profile' is missing outputSchema"))
    ).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Scenario C: Invalid output schema (SPEC §13 Scenario C)
  // -------------------------------------------------------------------------
  it("Scenario C: live Companion has incompatible output schema -> healthy: false, type mismatch diagnostic", async () => {
    await registerFakeCompanion("invalid-output-schema");

    const validation = await validateCompanionSetup({
      workspace: workspaceDir,
      host_id: "cursor",
    });

    expect(validation.registered).toBe(true);
    expect(validation.reachable).toBe(true);
    expect(validation.healthy).toBe(false);
    expect(validation.health?.healthy).toBe(false);
    expect(
      validation.health?.schema_errors.some((e) =>
        e.includes("Tool 'save_profile' response property 'success' has incompatible type")
      )
    ).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Scenario D: Missing tool (SPEC §13 Scenario D)
  // -------------------------------------------------------------------------
  it("Scenario D: live Companion advertises 7 / 8 tools -> healthy: false, missing_tools populated", async () => {
    await registerFakeCompanion("missing-tool");

    const validation = await validateCompanionSetup({
      workspace: workspaceDir,
      host_id: "cursor",
    });

    expect(validation.registered).toBe(true);
    expect(validation.reachable).toBe(true);
    expect(validation.healthy).toBe(false);
    expect(validation.health?.healthy).toBe(false);
    expect(validation.health?.missing_tools).toContain("reset_profile");
  });

  // -------------------------------------------------------------------------
  // Scenario E: MCP unreachable (SPEC §13 Scenario E)
  // -------------------------------------------------------------------------
  it("Scenario E: registered configuration points at unreachable process -> registered: true, reachable: false, healthy: false", async () => {
    const cursorDir = path.join(workspaceDir, ".cursor");
    await fsp.mkdir(cursorDir, { recursive: true });
    const configPath = path.join(cursorDir, "mcp.json");
    const mcpConfig = {
      mcpServers: {
        "agent-config": {
          command: process.execPath,
          args: [fakeCompanionScript, "--scenario=unreachable"],
        },
      },
    };
    await fsp.writeFile(configPath, JSON.stringify(mcpConfig, null, 2), "utf-8");

    const validation = await validateCompanionSetup({
      workspace: workspaceDir,
      host_id: "cursor",
    });

    expect(validation.registered).toBe(true);
    expect(validation.reachable).toBe(false);
    expect(validation.healthy).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Scenario F: Fully compatible Companion (SPEC §13 Scenario F)
  // -------------------------------------------------------------------------
  it("Scenario F: live Companion is fully compliant with contract -> registered: true, reachable: true, healthy: true", async () => {
    await registerFakeCompanion("canonical");

    const validation = await validateCompanionSetup({
      workspace: workspaceDir,
      host_id: "cursor",
    });

    expect(validation.registered).toBe(true);
    expect(validation.reachable).toBe(true);
    expect(validation.healthy).toBe(true);
    expect(validation.health?.healthy).toBe(true);
    expect(validation.health?.protocol_version).toBe(1);
    expect(validation.health?.missing_tools).toHaveLength(0);
    expect(validation.health?.schema_errors).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Scenario G: Registration succeeds, health fails (SPEC §14 Scenario G)
  // -------------------------------------------------------------------------
  it("Scenario G: registration applied but companion unreachable/incompatible -> setup NOT completed successfully", async () => {
    // Adapter preview & apply for opencode
    const preview = await previewCompanionSetup({
      workspace: workspaceDir,
      host_id: "opencode",
    });

    // Apply registration mutation to disk
    const applyResult = await applyCompanionSetup({
      workspace: workspaceDir,
      host_id: "opencode",
      preview_id: preview.preview_id,
      preview_hash: preview.preview_hash,
      baseline_hash: preview.baseline_hash,
      explicit_approval: true,
    });

    // Registration mutation was applied
    expect(applyResult.applied_targets.length).toBeGreaterThan(0);

    // But companion process is unreachable/unhealthy
    expect(applyResult.validation?.healthy).toBe(false);

    // Setup lifecycle reports repair_required and success: false (never completed / success: true)
    const lifecycle = await runCompanionSetupLifecycle({
      workspace: workspaceDir,
      host_id: "opencode",
    });

    expect(lifecycle.stage).not.toBe("completed");
    expect(lifecycle.stage).toBe("repair_required");
    expect(lifecycle.success).toBe(false);
    expect(lifecycle.message).not.toContain("already registered and validated");
  });

  // -------------------------------------------------------------------------
  // Scenario H: Registration succeeds, Companion healthy (SPEC §14 Scenario H)
  // -------------------------------------------------------------------------
  it("Scenario H: registration applied and companion healthy -> setup completes successfully (stage: completed, success: true)", async () => {
    // Set up mock/simulated healthy companion options for lifecycle apply
    await registerFakeCompanion("canonical");

    const lifecycle = await runCompanionSetupLifecycle({
      workspace: workspaceDir,
      host_id: "cursor",
    });

    expect(lifecycle.stage).toBe("completed");
    expect(lifecycle.success).toBe(true);
    expect(lifecycle.validation?.healthy).toBe(true);
    expect(lifecycle.message).toContain("registered and validated");
  });

  // -------------------------------------------------------------------------
  // CLI setup --check tests (SPEC §11)
  // -------------------------------------------------------------------------
  describe("CLI agent-config setup --check", () => {
    it("returns exit code 1 when unregistered", async () => {
      const code = await runSetupCli([
        "--workspace",
        workspaceDir,
        "--host",
        "cursor",
        "--check",
      ]);
      expect(code).toBe(1);
    });

    it("returns exit code 1 when registered but unhealthy (Scenario A)", async () => {
      await registerFakeCompanion("wrong-protocol");

      const code = await runSetupCli([
        "--workspace",
        workspaceDir,
        "--host",
        "cursor",
        "--check",
      ]);
      expect(code).toBe(1);
    });

    it("returns exit code 0 when registered and healthy (Scenario F)", async () => {
      await registerFakeCompanion("canonical");

      const code = await runSetupCli([
        "--workspace",
        workspaceDir,
        "--host",
        "cursor",
        "--check",
      ]);
      expect(code).toBe(0);
    });
  });
});
