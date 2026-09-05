import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ProfileStore } from "../src/profile/store.js";
import { AdapterRegistry } from "../src/adapters/registry.js";
import { PreviewManager } from "../src/server/preview.js";
import { handlePreviewConfiguration } from "../src/server/tools/preview-configuration.js";
import { validateCompanionSetup } from "../src/setup/lifecycle.js";
import { HostAdapter, HostCapabilities } from "../src/adapters/contract.js";
import { Profile, ExecutionConfig } from "../src/profile/schema.js";
import {
  CANONICAL_TOOL_CONTRACTS,
  TOOL_NAMES,
  CompanionToolDefinition,
} from "../src/contracts/index.js";

describe("SPEC §11: Production-Path Repairs Verification", () => {
  let tempDir: string;
  let workspaceDir: string;
  let profileStore: ProfileStore;
  let adapterRegistry: AdapterRegistry;
  let previewManager: PreviewManager;

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(
      path.join(os.tmpdir(), "agent-config-prod-repairs-")
    );
    workspaceDir = path.join(tempDir, "workspace");
    await fsp.mkdir(workspaceDir, { recursive: true });

    profileStore = new ProfileStore({
      baseDir: path.join(tempDir, "profiles"),
    });
    adapterRegistry = new AdapterRegistry();
    previewManager = new PreviewManager();
  });

  afterEach(async () => {
    if (fs.existsSync(tempDir)) {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  function getContext() {
    return { profileStore, adapterRegistry, previewManager };
  }

  function getCanonicalTools(): CompanionToolDefinition[] {
    return TOOL_NAMES.map((name) => {
      const contract = CANONICAL_TOOL_CONTRACTS[name];
      return {
        name,
        description: contract.description,
        parameters: contract.parameters,
        requiredParameters: contract.requiredParameters,
        responseProperties: contract.responseProperties,
        requiredResponseProperties: contract.requiredResponseProperties,
      };
    });
  }

  // -------------------------------------------------------------------------
  // Scenario A: Unauthorized Model
  // Profile authorizes model-A; ExecutionConfig selects model-X -> REJECT
  // Adapter preview call count MUST be 0
  // -------------------------------------------------------------------------
  it("Scenario A: Unauthorized model -> preview_configuration rejected and adapter preview call count = 0", async () => {
    const profile: Profile = {
      profile_version: 1,
      host: { id: "test-host", adapter: "test-host" },
      scope: { type: "project", workspace: workspaceDir },
      model_mode: "single",
      single_model: {
        model: "model-A",
        execution_effort: { policy: "highest-supported" },
      },
      capabilities: {
        subagents: "unavailable",
        threads: "unavailable",
        parallelism: "unavailable",
      },
    };
    await profileStore.saveProfile(profile);

    const previewSpy = vi.fn().mockResolvedValue({
      preview_id: "preview-spy-1",
      mutation_targets: [path.join(workspaceDir, "config.json")],
      diff: "+diff",
    });

    const mockAdapter: HostAdapter = {
      id: "test-host",
      identifyHost: async () => true,
      inspectVersion: async () => ({
        version: "1.0",
        compatibility: "supported",
        fail_closed_for_mutation: false,
      }),
      inspectCapabilities: async () => ({
        host_id: "test-host",
        adapter_id: "test-host",
        observed_at: new Date().toISOString(),
        available_models: ["model-A", "model-X"],
        supported_effort_values: ["low", "high"],
        capabilities: {
          subagents: { state: "unavailable" },
          threads: { state: "unavailable" },
          parallelism: { state: "unavailable" },
          model_selection: { state: "available", scopes: ["current-session"] },
        },
      }),
      renderConfiguration: previewSpy,
      applyConfiguration: async () => ({ success: true, preview_id: "p1", applied_targets: [] }),
      validateConfiguration: async () => ({ valid: true }),
      inspectCompanionRegistration: async () => ({ registered: false }),
      previewCompanionRegistration: async () => ({ supported: false, target_file: "", diff: "", mutation_targets: [] }),
      applyCompanionRegistration: async () => ({ success: false }),
      validateCompanionRegistration: async () => ({ valid: false }),
    };
    adapterRegistry.register(mockAdapter);

    const unauthorizedConfig: ExecutionConfig = {
      task_shape: "single-pass",
      model_mode: "single",
      readiness: "executable",
      topology: { type: "single-session", concurrency: 1 },
      execution: { model: "model-X", effort: "high", context: "current-session" },
      review: { strategy: "self-check", model: "model-X", effort: "high", context: "current-session" },
    };

    await expect(
      handlePreviewConfiguration(
        { config: unauthorizedConfig, workspace: workspaceDir },
        getContext()
      )
    ).rejects.toThrow(/not explicitly authorized in user profile/);

    // INVARIANT: Adapter preview call count must be 0!
    expect(previewSpy).toHaveBeenCalledTimes(0);
  });

  // -------------------------------------------------------------------------
  // Scenario B: Host Unavailable Model
  // Profile authorizes model-A; HostCapabilities does NOT evidence model-A -> REJECT
  // -------------------------------------------------------------------------
  it("Scenario B: Host unavailable model -> preview_configuration rejected", async () => {
    const profile: Profile = {
      profile_version: 1,
      host: { id: "test-host", adapter: "test-host" },
      scope: { type: "project", workspace: workspaceDir },
      model_mode: "single",
      single_model: {
        model: "model-A",
        execution_effort: { policy: "highest-supported" },
      },
      capabilities: {
        subagents: "unavailable",
        threads: "unavailable",
        parallelism: "unavailable",
      },
    };
    await profileStore.saveProfile(profile);

    const mockAdapter: HostAdapter = {
      id: "test-host",
      identifyHost: async () => true,
      inspectVersion: async () => ({
        version: "1.0",
        compatibility: "supported",
        fail_closed_for_mutation: false,
      }),
      inspectCapabilities: async () => ({
        host_id: "test-host",
        adapter_id: "test-host",
        observed_at: new Date().toISOString(),
        available_models: ["model-B"], // model-A is NOT evidenced as available!
        supported_effort_values: ["low", "high"],
        capabilities: {
          subagents: { state: "unavailable" },
          threads: { state: "unavailable" },
          parallelism: { state: "unavailable" },
          model_selection: { state: "available", scopes: ["current-session"] },
        },
      }),
      renderConfiguration: async () => ({ preview_id: "p1", mutation_targets: [], diff: "" }),
      applyConfiguration: async () => ({ success: true, preview_id: "p1", applied_targets: [] }),
      validateConfiguration: async () => ({ valid: true }),
      inspectCompanionRegistration: async () => ({ registered: false }),
      previewCompanionRegistration: async () => ({ supported: false, target_file: "", diff: "", mutation_targets: [] }),
      applyCompanionRegistration: async () => ({ success: false }),
      validateCompanionRegistration: async () => ({ valid: false }),
    };
    adapterRegistry.register(mockAdapter);

    const configWithUnavailableModel: ExecutionConfig = {
      task_shape: "single-pass",
      model_mode: "single",
      readiness: "executable",
      topology: { type: "single-session", concurrency: 1 },
      execution: { model: "model-A", effort: "high", context: "current-session" },
      review: { strategy: "self-check", model: "model-A", effort: "high", context: "current-session" },
    };

    await expect(
      handlePreviewConfiguration(
        { config: configWithUnavailableModel, workspace: workspaceDir },
        getContext()
      )
    ).rejects.toThrow(/not evidenced as available on host/);
  });

  // -------------------------------------------------------------------------
  // Scenario C: host_id != adapter_id
  // host_id = fixture-host; adapter_id = test-adapter
  // Save profile under fixture-host; preview_configuration -> PASS
  // -------------------------------------------------------------------------
  it("Scenario C: host_id != adapter_id -> profile correctly resolved under concrete host_id and passes", async () => {
    const concreteHostId = "fixture-host";
    const adapterId = "test-adapter";

    // Save profile strictly under fixture-host (adapter-id profile is absent)
    const profile: Profile = {
      profile_version: 1,
      host: { id: concreteHostId, adapter: adapterId },
      scope: { type: "project", workspace: workspaceDir },
      model_mode: "single",
      single_model: {
        model: "fixture-model",
        execution_effort: { policy: "highest-supported" },
      },
      capabilities: {
        subagents: "unavailable",
        threads: "unavailable",
        parallelism: "unavailable",
      },
    };
    await profileStore.saveProfile(profile);

    // Verify profile is NOT present under adapter.id
    const adapterProfile = await profileStore.getProfile(adapterId, workspaceDir);
    expect(adapterProfile).toBeNull();

    // Verify profile IS present under concrete host_id
    const hostProfile = await profileStore.getProfile(concreteHostId, workspaceDir);
    expect(hostProfile).not.toBeNull();

    const mockAdapter: HostAdapter = {
      id: adapterId,
      identifyHost: async () => true,
      inspectVersion: async () => ({
        version: "1.0",
        compatibility: "supported",
        fail_closed_for_mutation: false,
      }),
      inspectCapabilities: async () => ({
        host_id: concreteHostId, // inspected host_id is different from adapter.id!
        adapter_id: adapterId,
        observed_at: new Date().toISOString(),
        available_models: ["fixture-model"],
        supported_effort_values: ["low", "high"],
        capabilities: {
          subagents: { state: "unavailable" },
          threads: { state: "unavailable" },
          parallelism: { state: "unavailable" },
          model_selection: { state: "available", scopes: ["current-session"] },
        },
      }),
      renderConfiguration: async () => ({
        preview_id: "preview-diff-host-id",
        mutation_targets: [path.join(workspaceDir, "fixture.conf")],
        diff: "+model = fixture-model",
      }),
      applyConfiguration: async () => ({ success: true, preview_id: "p1", applied_targets: [] }),
      validateConfiguration: async () => ({ valid: true }),
      inspectCompanionRegistration: async () => ({ registered: false }),
      previewCompanionRegistration: async () => ({ supported: false, target_file: "", diff: "", mutation_targets: [] }),
      applyCompanionRegistration: async () => ({ success: false }),
      validateCompanionRegistration: async () => ({ valid: false }),
    };
    adapterRegistry.register(mockAdapter);

    const validConfig: ExecutionConfig = {
      task_shape: "single-pass",
      model_mode: "single",
      readiness: "executable",
      topology: { type: "single-session", concurrency: 1 },
      execution: { model: "fixture-model", effort: "high", context: "current-session" },
      review: { strategy: "self-check", model: "fixture-model", effort: "high", context: "current-session" },
    };

    const previewResult = await handlePreviewConfiguration(
      { config: validConfig, workspace: workspaceDir },
      getContext()
    );

    expect(previewResult.preview_id).toBeDefined();
    expect(previewResult.diff).toContain("fixture-model");
  });

  // -------------------------------------------------------------------------
  // Scenario D: Fake Companion Health
  // registration exists + command exists + unreachable -> NOT healthy
  // -------------------------------------------------------------------------
  it("Scenario D: Fake Companion health -> registered + command exists + unreachable -> healthy = false", async () => {
    const validation = await validateCompanionSetup({
      workspace: workspaceDir,
      host_id: "generic",
      reachable: false, // process is unreachable!
      tools: getCanonicalTools(),
      protocol_version: 1,
    });

    expect(validation.reachable).toBe(false);
    expect(validation.healthy).toBe(false);
    expect(validation.health?.healthy).toBe(false);
    expect(
      validation.health?.reasons.some((r) =>
        r.includes("unreachable or unresponsive")
      )
    ).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Scenario E: Missing Canonical Tool
  // reachable + 7 / 8 tools -> healthy = false
  // -------------------------------------------------------------------------
  it("Scenario E: Missing canonical tool -> 7/8 tools -> healthy = false", async () => {
    const sevenTools = getCanonicalTools().filter(
      (t) => t.name !== "reset_profile"
    );
    expect(sevenTools).toHaveLength(7);

    const validation = await validateCompanionSetup({
      workspace: workspaceDir,
      host_id: "generic",
      reachable: true,
      tools: sevenTools,
      protocol_version: 1,
    });

    expect(validation.healthy).toBe(false);
    expect(validation.health?.healthy).toBe(false);
    expect(validation.health?.missing_tools).toContain("reset_profile");
  });

  // -------------------------------------------------------------------------
  // Scenario F: Schema Mismatch
  // reachable + 8 tools + wrong schema -> healthy = false
  // -------------------------------------------------------------------------
  it("Scenario F: Schema mismatch -> 8 tools + wrong parameter schema -> healthy = false", async () => {
    const canonicalTools = getCanonicalTools();
    // Corrupt one tool's parameter schema
    const corruptedTools = canonicalTools.map((t) => {
      if (t.name === "preview_configuration") {
        return {
          ...t,
          parameters: {
            config: { type: "number", required: true }, // incompatible type: expected object
          },
        };
      }
      return t;
    });

    const validation = await validateCompanionSetup({
      workspace: workspaceDir,
      host_id: "generic",
      reachable: true,
      tools: corruptedTools,
      protocol_version: 1,
    });

    expect(validation.healthy).toBe(false);
    expect(validation.health?.healthy).toBe(false);
    expect(validation.health?.schema_errors.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // Scenario F.2: Protocol version mismatch
  // reachable + 8 tools + protocol != 1 -> healthy = false
  // -------------------------------------------------------------------------
  it("Scenario F.2: Protocol mismatch -> 8 tools + protocol 2 -> healthy = false", async () => {
    const validation = await validateCompanionSetup({
      workspace: workspaceDir,
      host_id: "generic",
      reachable: true,
      tools: getCanonicalTools(),
      protocol_version: 2, // incompatible protocol version
    });

    expect(validation.healthy).toBe(false);
    expect(validation.health?.healthy).toBe(false);
    expect(
      validation.health?.reasons.some((r) => r.includes("Protocol version mismatch"))
    ).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Scenario F.3: Canonical Healthy Companion
  // reachable + protocol 1 + compatible 8 tools -> healthy = true
  // -------------------------------------------------------------------------
  it("Scenario F.3: Canonical healthy companion -> reachable + protocol 1 + 8 tools -> healthy = true", async () => {
    const validation = await validateCompanionSetup({
      workspace: workspaceDir,
      host_id: "generic",
      reachable: true,
      tools: getCanonicalTools(),
      protocol_version: 1,
    });

    expect(validation.healthy).toBe(true);
    expect(validation.health?.healthy).toBe(true);
    expect(validation.health?.missing_tools).toHaveLength(0);
    expect(validation.health?.schema_errors).toHaveLength(0);
    expect(validation.health?.reasons).toHaveLength(0);
  });
});
