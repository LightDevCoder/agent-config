import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ProfileStore } from "../src/profile/store.js";
import { AdapterRegistry } from "../src/adapters/registry.js";
import { GenericAdapter } from "../src/adapters/generic/index.js";
import { PreviewManager } from "../src/server/preview.js";
import { createServer } from "../src/server/index.js";
import {
  handleGetSetupStatus,
  handleInspectHost,
  handleGetProfile,
  handleSaveProfile,
  handlePreviewConfiguration,
  handleApplyConfiguration,
  handleValidateConfiguration,
  handleResetProfile,
} from "../src/server/tools/index.js";
import { HostAdapter, HostCapabilities } from "../src/adapters/contract.js";
import { Profile } from "../src/profile/schema.js";

describe("Core MCP Tools Surface (8 Tools)", () => {
  let tempDir: string;
  let workspaceDir: string;
  let profileStore: ProfileStore;
  let adapterRegistry: AdapterRegistry;
  let previewManager: PreviewManager;

  const validProfile: Profile = {
    profile_version: 1,
    host: {
      id: "generic",
      adapter: "generic",
    },
    scope: {
      type: "project",
      workspace: "/dummy/path", // will be updated in tests
    },
    model_mode: "single",
    models: {
      available: ["test-model"],
    },
    single_model: {
      model: "test-model",
      execution_effort: { policy: "highest-supported" },
    },
    capabilities: {
      subagents: "unknown",
      threads: "unknown",
      parallelism: "unknown",
    },
  };

  const validExecutionConfig: ExecutionConfig = {
    task_shape: "single-pass",
    model_mode: "single",
    readiness: "executable",
    topology: {
      type: "single-session",
      concurrency: 1,
    },
    execution: {
      model: "test-model",
      effort: "high",
      effort_policy: "highest-supported",
      context: "current-session",
    },
    review: {
      strategy: "self-check",
      model: "test-model",
      effort: "high",
      context: "current-session",
    },
  };

  class TestGenericAdapter extends GenericAdapter {
    override async inspectCapabilities(workspaceRoot?: string) {
      const base = await super.inspectCapabilities(workspaceRoot);
      return {
        ...base,
        available_models: [{ id: "test-model", state: "available" as const }],
        supported_effort_values: ["low", "high"],
      };
    }
  }

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-config-tools-test-"));
    workspaceDir = path.join(tempDir, "workspace");
    await fsp.mkdir(workspaceDir, { recursive: true });

    profileStore = new ProfileStore({ baseDir: path.join(tempDir, "profiles") });
    adapterRegistry = new AdapterRegistry(new TestGenericAdapter());
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

  describe("1. get_setup_status", () => {
    it("should return configured=false when no profile exists", async () => {
      const status = await handleGetSetupStatus({ workspace: workspaceDir }, getContext());
      expect(status.configured).toBe(false);
      expect(status.protocol_version).toBe(1);
      expect(status.profile_version).toBeNull();
      expect(status.stale).toBe(false);
      expect(status.adapter_id).toBe("generic");
    });

    it("should return configured=true and stale=false for valid stored profile", async () => {
      const profile = {
        ...validProfile,
        scope: { type: "project" as const, workspace: workspaceDir },
      };
      await profileStore.saveProfile(profile);

      const status = await handleGetSetupStatus({ workspace: workspaceDir }, getContext());
      expect(status.configured).toBe(true);
      expect(status.protocol_version).toBe(1);
      expect(status.profile_version).toBe(1);
      expect(status.stale).toBe(false);
      expect(status.host_id).toBe("generic");
      expect(status.adapter_id).toBe("generic");
    });

    it("should return stale=true when profile has conflict with current host", async () => {
      // Mock adapter reporting conflict with profile's adapter
      class ConflictAdapter extends GenericAdapter {
        override readonly id = "generic";
        override async inspectCapabilities(w: string): Promise<HostCapabilities> {
          const caps = await super.inspectCapabilities(w);
          return {
            ...caps,
            adapter_id: "different-adapter-id", // mismatch with profile.host.adapter ("generic")!
          };
        }
      }

      const customRegistry = new AdapterRegistry(new ConflictAdapter());
      const profile = {
        ...validProfile,
        scope: { type: "project" as const, workspace: workspaceDir },
      };
      await profileStore.saveProfile(profile);

      const status = await handleGetSetupStatus(
        { workspace: workspaceDir },
        { profileStore, adapterRegistry: customRegistry, previewManager }
      );
      expect(status.configured).toBe(true);
      expect(status.stale).toBe(true);
      expect(status.stale_reasons.length).toBeGreaterThan(0);
    });
  });

  describe("2. inspect_host", () => {
    it("should return host capabilities from adapter", async () => {
      const caps = await handleInspectHost({ workspace: workspaceDir }, getContext());
      expect(caps.host_id).toBe("generic");
      expect(caps.adapter_id).toBe("generic");
      expect(caps.capabilities).toBeDefined();
    });
  });

  describe("3. get_profile", () => {
    it("should return found=false when profile is absent", async () => {
      const res = await handleGetProfile({ workspace: workspaceDir }, getContext());
      expect(res.found).toBe(false);
      expect(res.profile).toBeUndefined();
    });

    it("should return found=true with profile document when present", async () => {
      const profile = {
        ...validProfile,
        scope: { type: "project" as const, workspace: workspaceDir },
      };
      await profileStore.saveProfile(profile);

      const res = await handleGetProfile({ workspace: workspaceDir }, getContext());
      expect(res.found).toBe(true);
      expect(res.profile?.single_model?.model).toBe("test-model");
    });
  });

  describe("4. save_profile", () => {
    it("should atomically save valid profile", async () => {
      const profile = {
        ...validProfile,
        scope: { type: "project" as const, workspace: workspaceDir },
      };
      const res = await handleSaveProfile({ profile, workspace: workspaceDir }, getContext());
      expect(res.success).toBe(true);
      expect(res.profile.scope.workspace).toBe(workspaceDir);

      const retrieved = await profileStore.getProfile("generic", workspaceDir);
      expect(retrieved?.single_model?.model).toBe("test-model");
    });

    it("should reject invalid profile failing schema", async () => {
      const invalidProfile = {
        ...validProfile,
        routing_rank: 1, // FORBIDDEN
      };

      await expect(
        handleSaveProfile({ profile: invalidProfile, workspace: workspaceDir }, getContext())
      ).rejects.toThrow();
    });
  });

  describe("5. preview_configuration", () => {
    it("should render configuration preview with preview_id, preview_hash, target, baseline_hash, and diff", async () => {
      await profileStore.saveProfile({
        ...validProfile,
        scope: { type: "project", workspace: workspaceDir },
      });

      const res = await handlePreviewConfiguration(
        { config: validExecutionConfig, workspace: workspaceDir },
        getContext()
      );

      expect(res.preview_id).toBeDefined();
      expect(res.preview_hash).toMatch(/^sha256-[a-f0-9]+$/);
      expect(res.diff).toContain("Plan-Only Configuration");
      expect(res.target).toBeDefined();
      expect(res.expires_at).toBeDefined();
      expect(res.mutation_targets).toBeDefined();
      expect(previewManager.getPreview(res.preview_id)).toBeDefined();
    });

    it("should fail closed and reject preview when config is missing required fields", async () => {
      // Incomplete config missing required task_shape, model_mode, readiness, topology, review
      const malformedConfig = { model: "o3-mini", effort: "high" };

      await expect(
        handlePreviewConfiguration(
          { config: malformedConfig, workspace: workspaceDir },
          getContext()
        )
      ).rejects.toThrow(/canonical schema validation/);
    });

    it("should fail closed when config is null or non-object", async () => {
      await expect(
        handlePreviewConfiguration(
          { config: null as any, workspace: workspaceDir },
          getContext()
        )
      ).rejects.toThrow();
    });

    it("should fail closed and reject arbitrary unstructured configuration payload", async () => {
      const unstructured = {
        arbitrary_key: 12345,
        random_field: "not-a-valid-config",
      };
      await expect(
        handlePreviewConfiguration(
          { config: unstructured, workspace: workspaceDir },
          getContext()
        )
      ).rejects.toThrow(/canonical schema validation/);
    });
  });

  describe("6. apply_configuration", () => {
    it("should apply configuration when preview is valid", async () => {
      await profileStore.saveProfile({
        ...validProfile,
        scope: { type: "project", workspace: workspaceDir },
      });

      const preview = await handlePreviewConfiguration(
        { config: validExecutionConfig, workspace: workspaceDir },
        getContext()
      );

      const applyRes = await handleApplyConfiguration(
        { preview_id: preview.preview_id, workspace: workspaceDir },
        getContext()
      );

      expect(applyRes.success).toBe(true);
      expect(applyRes.preview_id).toBe(preview.preview_id);
      expect(applyRes.target).toBeDefined();

      // Verify second apply is rejected (already applied)
      await expect(
        handleApplyConfiguration(
          { preview_id: preview.preview_id, workspace: workspaceDir },
          getContext()
        )
      ).rejects.toThrow(/already been applied/);
    });

    it("should reject apply when preview ID is nonexistent", async () => {
      await expect(
        handleApplyConfiguration(
          { preview_id: "nonexistent-id", workspace: workspaceDir },
          getContext()
        )
      ).rejects.toThrow(/not found or has expired/);
    });

    it("should reject apply when target files have drifted since preview", async () => {
      await profileStore.saveProfile({
        ...validProfile,
        scope: { type: "project", workspace: workspaceDir },
      });

      const targetFile = path.join(workspaceDir, "test-target.json");
      await fsp.writeFile(targetFile, JSON.stringify({ original: true }), "utf-8");

      // Custom adapter that targets this file
      class FileMutatingAdapter extends TestGenericAdapter {
        override async renderConfiguration(
          _plan: ExecutionConfig,
          _profile?: any,
          _workspaceRoot?: string
        ) {
          return {
            preview_id: "preview-file-test",
            mutation_targets: [targetFile],
            diff: "will update target",
          };
        }
      }

      const mutRegistry = new AdapterRegistry(new FileMutatingAdapter());
      const ctx = { profileStore, adapterRegistry: mutRegistry, previewManager };

      // Take preview while file has { original: true }
      const preview = await handlePreviewConfiguration(
        { config: validExecutionConfig, workspace: workspaceDir },
        ctx
      );

      // Drift: modify file before apply!
      await fsp.writeFile(targetFile, JSON.stringify({ original: false, drifted: true }), "utf-8");

      // Apply should now be rejected due to anti-drift guard
      await expect(
        handleApplyConfiguration({ preview_id: preview.preview_id, workspace: workspaceDir }, ctx)
      ).rejects.toThrow(/changed since preview was generated/);
    });
  });

  describe("7. validate_configuration", () => {
    it("should return valid=true when adapter verifies state", async () => {
      const res = await handleValidateConfiguration(
        { expected_config: validExecutionConfig, workspace: workspaceDir },
        getContext()
      );
      expect(res.valid).toBe(true);
    });
  });

  describe("Validation baseline rejection", () => {
    it.each([{}, { expected_config: {} }, { preview_id: "does-not-exist" },
      { preview_id: "does-not-exist", expected_config: validExecutionConfig }])(
      "rejects missing or invalid baselines %j", async (input) => {
        await expect(handleValidateConfiguration({ ...input, workspace: workspaceDir }, getContext()))
          .rejects.toThrow(/expected_config|preview_id/);
      }
    );

    it("keeps validation tied to the preview workspace and host", async () => {
      await profileStore.saveProfile({ ...validProfile, scope: { type: "project", workspace: workspaceDir } });
      const preview = await handlePreviewConfiguration({ config: validExecutionConfig, workspace: workspaceDir }, getContext());
      await expect(handleValidateConfiguration({ preview_id: preview.preview_id, workspace: tempDir }, getContext()))
        .rejects.toThrow(/workspace mismatch/);
      await expect(handleValidateConfiguration({ preview_id: preview.preview_id, workspace: workspaceDir, host_id: "codex" }, getContext()))
        .rejects.toThrow(/host mismatch/);
    });
  });

  describe("8. reset_profile", () => {
    it("should safely clear profile", async () => {
      const profile = {
        ...validProfile,
        scope: { type: "project" as const, workspace: workspaceDir },
      };
      await profileStore.saveProfile(profile);

      const resetRes = await handleResetProfile({ workspace: workspaceDir }, getContext());
      expect(resetRes.success).toBe(true);
      expect(resetRes.cleared).toBe(true);

      const status = await handleGetSetupStatus({ workspace: workspaceDir }, getContext());
      expect(status.configured).toBe(false);
    });
  });

  describe("Full MCP Protocol Integration via InMemoryTransport", () => {
    let client: Client;
    let server: ReturnType<typeof createServer>;

    beforeEach(async () => {
      server = createServer({
        profileStore,
        adapterRegistry,
        previewManager,
      });

      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

      client = new Client({ name: "test-client", version: "1.0.0" });

      await Promise.all([
        client.connect(clientTransport),
        server.connect(serverTransport),
      ]);
    });

    afterEach(async () => {
      await client.close();
      await server.close();
    });

    it("should list all 8 core tools via MCP protocol", async () => {
      const toolsResult = await client.listTools();
      const toolNames = toolsResult.tools.map((t) => t.name);

      expect(toolNames).toHaveLength(8);
      expect(toolNames).toContain("get_setup_status");
      expect(toolNames).toContain("inspect_host");
      expect(toolNames).toContain("get_profile");
      expect(toolNames).toContain("save_profile");
      expect(toolNames).toContain("preview_configuration");
      expect(toolNames).toContain("apply_configuration");
      expect(toolNames).toContain("validate_configuration");
      expect(toolNames).toContain("reset_profile");
    });

    it("should execute full setup, preview, apply, and reset cycle over MCP protocol", async () => {
      // 1. Check setup status initially unconfigured
      const statusRes = await client.callTool({
        name: "get_setup_status",
        arguments: { workspace: workspaceDir },
      });
      expect(statusRes.isError).toBeFalsy();
      const statusData = JSON.parse((statusRes.content[0] as any).text);
      expect(statusData.configured).toBe(false);

      // 2. Inspect host
      const inspectRes = await client.callTool({
        name: "inspect_host",
        arguments: { workspace: workspaceDir },
      });
      const hostData = JSON.parse((inspectRes.content[0] as any).text);
      expect(hostData.host_id).toBe("generic");

      // 3. Save profile
      const profileToSave = {
        ...validProfile,
        scope: { type: "project", workspace: workspaceDir },
      };
      const saveRes = await client.callTool({
        name: "save_profile",
        arguments: { profile: profileToSave, workspace: workspaceDir },
      });
      expect(saveRes.isError).toBeFalsy();
      const saveData = JSON.parse((saveRes.content[0] as any).text);
      expect(saveData.success).toBe(true);

      // 4. Verify get_setup_status is now configured
      const statusRes2 = await client.callTool({
        name: "get_setup_status",
        arguments: { workspace: workspaceDir },
      });
      const statusData2 = JSON.parse((statusRes2.content[0] as any).text);
      expect(statusData2.configured).toBe(true);
      expect(statusData2.protocol_version).toBe(1);
      expect(statusData2.stale).toBe(false);

      // 5. Get profile
      const getRes = await client.callTool({
        name: "get_profile",
        arguments: { workspace: workspaceDir },
      });
      const getData = JSON.parse((getRes.content[0] as any).text);
      expect(getData.found).toBe(true);
      expect(getData.profile.single_model.model).toBe("test-model");

      // 6. Preview configuration (fail-closed test: malformed config returns error)
      const badPreviewRes = await client.callTool({
        name: "preview_configuration",
        arguments: { config: { invalid: true }, workspace: workspaceDir },
      });
      expect(badPreviewRes.isError).toBe(true);
      expect((badPreviewRes.content[0] as any).text).toContain("preview_configuration error");

      // Valid preview configuration succeeds
      const previewRes = await client.callTool({
        name: "preview_configuration",
        arguments: { config: validExecutionConfig, workspace: workspaceDir },
      });
      expect(previewRes.isError).toBeFalsy();
      const previewData = JSON.parse((previewRes.content[0] as any).text);
      expect(previewData.preview_id).toBeDefined();
      expect(previewData.preview_hash).toBeDefined();
      expect(previewData.target).toBeDefined();

      // 7. Apply configuration
      const applyRes = await client.callTool({
        name: "apply_configuration",
        arguments: { preview_id: previewData.preview_id, workspace: workspaceDir },
      });
      const applyData = JSON.parse((applyRes.content[0] as any).text);
      expect(applyData.success).toBe(true);

      // 8. Validate configuration
      const valRes = await client.callTool({
        name: "validate_configuration",
        arguments: { preview_id: previewData.preview_id, workspace: workspaceDir },
      });
      const valData = JSON.parse((valRes.content[0] as any).text);
      expect(valData.valid).toBe(true);

      // 9. Reset profile
      const resetRes = await client.callTool({
        name: "reset_profile",
        arguments: { workspace: workspaceDir },
      });
      const resetData = JSON.parse((resetRes.content[0] as any).text);
      expect(resetData.cleared).toBe(true);

      // 10. Check status again: should be unconfigured
      const statusRes3 = await client.callTool({
        name: "get_setup_status",
        arguments: { workspace: workspaceDir },
      });
      const statusData3 = JSON.parse((statusRes3.content[0] as any).text);
      expect(statusData3.configured).toBe(false);
    });
  });
});
