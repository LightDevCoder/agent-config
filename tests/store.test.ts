import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ProfileStore } from "../src/profile/store.js";
import { Profile } from "../src/profile/schema.js";
import { HostCapabilities } from "../src/adapters/contract.js";

describe("ProfileStore", () => {
  let tempDir: string;
  let store: ProfileStore;

  const sampleSingleProfile: Profile = {
    profile_version: 1,
    host: {
      id: "test-host",
      adapter: "test-adapter",
    },
    scope: {
      type: "project",
      workspace: "/projects/alpha",
    },
    model_mode: "single",
    models: {
      available: ["gpt-4o", "o3-mini"],
    },
    single_model: {
      model: "o3-mini",
      execution_effort: { policy: "highest-supported" },
      review_effort: { policy: "highest-supported" },
    },
    capabilities: {
      subagents: "available",
      threads: "available",
      parallelism: "available",
      concurrency: 4,
    },
  };

  const sampleMultiProfile: Profile = {
    profile_version: 1,
    host: {
      id: "test-host",
      adapter: "test-adapter",
    },
    scope: {
      type: "project",
      workspace: "/projects/beta",
    },
    model_mode: "multi",
    models: {
      available: ["gpt-4o-mini", "gpt-4o", "o3-mini"],
    },
    tiers: {
      routine: {
        model: "gpt-4o-mini",
        effort: { value: "low" },
        source: "user-confirmed",
      },
      standard: {
        model: "gpt-4o",
        effort: { policy: "default" },
        source: "user-confirmed",
      },
      high: {
        model: "o3-mini",
        effort: { policy: "highest-supported" },
        source: "user-confirmed",
      },
      review: {
        model: "o3-mini",
        effort: { policy: "highest-supported" },
        source: "user-confirmed",
      },
    },
    capabilities: {
      subagents: "available",
      threads: "available",
      parallelism: "available",
      concurrency: 2,
    },
  };

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-config-store-test-"));
    store = new ProfileStore({ baseDir: tempDir });
  });

  afterEach(async () => {
    if (fs.existsSync(tempDir)) {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  describe("Base directory resolution", () => {
    it("should use explicit options.baseDir when provided", () => {
      const customDir = path.join(tempDir, "custom");
      const customStore = new ProfileStore({ baseDir: customDir });
      expect(customStore.baseDir).toBe(path.resolve(customDir));
    });

    it("should respect AGENT_CONFIG_HOME environment variable", () => {
      const prevEnv = process.env.AGENT_CONFIG_HOME;
      try {
        const homeDir = path.join(tempDir, "env-home");
        process.env.AGENT_CONFIG_HOME = homeDir;
        const envStore = new ProfileStore();
        expect(envStore.baseDir).toBe(path.join(path.resolve(homeDir), "profiles"));
      } finally {
        if (prevEnv !== undefined) {
          process.env.AGENT_CONFIG_HOME = prevEnv;
        } else {
          delete process.env.AGENT_CONFIG_HOME;
        }
      }
    });

    it("should respect AGENT_CONFIG_PROFILES_DIR directly", () => {
      const prevEnv = process.env.AGENT_CONFIG_PROFILES_DIR;
      try {
        const customProfiles = path.join(tempDir, "direct-profiles");
        process.env.AGENT_CONFIG_PROFILES_DIR = customProfiles;
        const envStore = new ProfileStore();
        expect(envStore.baseDir).toBe(path.resolve(customProfiles));
      } finally {
        if (prevEnv !== undefined) {
          process.env.AGENT_CONFIG_PROFILES_DIR = prevEnv;
        } else {
          delete process.env.AGENT_CONFIG_PROFILES_DIR;
        }
      }
    });
  });

  describe("Host & Workspace isolation", () => {
    it("should isolate profiles across different workspaces for the same host", async () => {
      const profileA: Profile = {
        ...sampleSingleProfile,
        scope: { type: "project", workspace: "/workspaces/project-alpha" },
      };
      const profileB: Profile = {
        ...sampleSingleProfile,
        scope: { type: "project", workspace: "/workspaces/project-beta" },
        single_model: { model: "gpt-4o" },
      };

      await store.saveProfile(profileA);
      await store.saveProfile(profileB);

      const loadedA = await store.getProfile("test-host", "/workspaces/project-alpha");
      const loadedB = await store.getProfile("test-host", "/workspaces/project-beta");

      expect(loadedA?.single_model?.model).toBe("o3-mini");
      expect(loadedB?.single_model?.model).toBe("gpt-4o");
    });

    it("should isolate profiles across different hosts for the same workspace", async () => {
      const profileCodex: Profile = {
        ...sampleSingleProfile,
        host: { id: "codex", adapter: "codex-adapter" },
        scope: { type: "project", workspace: "/workspaces/same-project" },
        single_model: { model: "o3-mini" },
      };
      const profileGeneric: Profile = {
        ...sampleSingleProfile,
        host: { id: "generic", adapter: "generic" },
        scope: { type: "project", workspace: "/workspaces/same-project" },
        single_model: { model: "gpt-4o" },
      };

      await store.saveProfile(profileCodex);
      await store.saveProfile(profileGeneric);

      const loadedCodex = await store.getProfile("codex", "/workspaces/same-project");
      const loadedGeneric = await store.getProfile("generic", "/workspaces/same-project");

      expect(loadedCodex?.single_model?.model).toBe("o3-mini");
      expect(loadedGeneric?.single_model?.model).toBe("gpt-4o");
    });

    it("should normalize workspace paths with trailing slashes to the same profile location", async () => {
      const profileWithSlash: Profile = {
        ...sampleSingleProfile,
        scope: { type: "project", workspace: "/workspaces/my-repo/" },
      };
      await store.saveProfile(profileWithSlash);

      // Query without trailing slash
      const retrieved = await store.getProfile("test-host", "/workspaces/my-repo");
      expect(retrieved).not.toBeNull();
      expect(retrieved?.single_model?.model).toBe("o3-mini");

      // Verify file paths match
      const path1 = store.getProfilePath("test-host", "/workspaces/my-repo/");
      const path2 = store.getProfilePath("test-host", "/workspaces/my-repo");
      expect(path1).toBe(path2);
    });
  });

  describe("Atomic writes and schema validation", () => {
    it("should save and retrieve a valid single-model profile", async () => {
      await store.saveProfile(sampleSingleProfile);
      const retrieved = await store.getProfile("test-host", "/projects/alpha");

      expect(retrieved).not.toBeNull();
      expect(retrieved?.host.id).toBe("test-host");
      expect(retrieved?.model_mode).toBe("single");
      expect(retrieved?.single_model?.model).toBe("o3-mini");
    });

    it("should save and retrieve a valid multi-model profile", async () => {
      await store.saveProfile(sampleMultiProfile);
      const retrieved = await store.getProfile("test-host", "/projects/beta");

      expect(retrieved).not.toBeNull();
      expect(retrieved?.model_mode).toBe("multi");
      expect(retrieved?.tiers?.routine.model).toBe("gpt-4o-mini");
      expect(retrieved?.tiers?.routine.source).toBe("user-confirmed");
    });

    it("should reject profile failing canonical schema and ensure no partial save", async () => {
      const invalidProfile: any = {
        profile_version: 1,
        host: { id: "test-host", adapter: "test-adapter" },
        scope: { type: "project", workspace: "/projects/invalid" },
        model_mode: "single",
        routing_rank: 999, // FORBIDDEN
        single_model: { model: "gpt-4o" },
      };

      await expect(store.saveProfile(invalidProfile)).rejects.toThrow();

      // Ensure no file was created
      const filePath = store.getProfilePath("test-host", "/projects/invalid");
      expect(fs.existsSync(filePath)).toBe(false);
    });

    it("should reject tier mapping with unconfirmed source and not save", async () => {
      const guessedTierProfile: any = {
        ...sampleMultiProfile,
        scope: { type: "project", workspace: "/projects/guessed" },
        tiers: {
          ...sampleMultiProfile.tiers,
          routine: {
            model: "gpt-4o-mini",
            source: "inferred", // FORBIDDEN
          },
        },
      };

      await expect(store.saveProfile(guessedTierProfile)).rejects.toThrow();
      expect(fs.existsSync(store.getProfilePath("test-host", "/projects/guessed"))).toBe(false);
    });
  });

  describe("Host inventory and effort validation on save", () => {
    const hostCapabilities: HostCapabilities = {
      host_id: "test-host",
      adapter_id: "test-adapter",
      observed_at: "2026-09-04T12:00:00Z",
      available_models: [
        { id: "gpt-4o-mini", state: "available" },
        { id: "gpt-4o", state: "available" },
        { id: "o3-mini", state: "available" },
        { id: "retired-model", state: "unavailable" },
      ],
      supported_effort_values: ["low", "medium", "high"],
      capabilities: {
        subagents: { state: "available" },
        threads: { state: "available" },
        parallelism: { state: "available" },
        model_selection: { state: "available" },
      },
    };

    it("should successfully save when profile models match host inventory", async () => {
      await expect(
        store.saveProfile(sampleSingleProfile, { hostCapabilities })
      ).resolves.not.toThrow();
    });

    it("should reject saving if single-model model is not available on host", async () => {
      const unknownModelProfile: Profile = {
        ...sampleSingleProfile,
        scope: { type: "project", workspace: "/projects/unknown-model" },
        single_model: { model: "non-existent-model" },
      };

      await expect(
        store.saveProfile(unknownModelProfile, { hostCapabilities })
      ).rejects.toThrow(/not available on host/);

      expect(
        fs.existsSync(store.getProfilePath("test-host", "/projects/unknown-model"))
      ).toBe(false);
    });

    it("should reject saving if a tier model is retired/unavailable on host", async () => {
      const retiredModelProfile: Profile = {
        ...sampleMultiProfile,
        scope: { type: "project", workspace: "/projects/retired-model" },
        tiers: {
          ...sampleMultiProfile.tiers!,
          routine: {
            model: "retired-model",
            source: "user-confirmed",
          },
        },
      };

      await expect(
        store.saveProfile(retiredModelProfile, { hostCapabilities })
      ).rejects.toThrow(/not available on host/);
    });

    it("should reject saving if concrete effort value is not supported by host", async () => {
      const unsupportedEffortProfile: Profile = {
        ...sampleMultiProfile,
        scope: { type: "project", workspace: "/projects/bad-effort" },
        tiers: {
          ...sampleMultiProfile.tiers!,
          routine: {
            model: "gpt-4o-mini",
            effort: { value: "ultra-high" }, // NOT in ["low", "medium", "high"]
            source: "user-confirmed",
          },
        },
      };

      await expect(
        store.saveProfile(unsupportedEffortProfile, { hostCapabilities })
      ).rejects.toThrow(/Effort value 'ultra-high' .* is not supported by host/);
    });
  });

  describe("Deletion and Listing", () => {
    it("should safely reset profile: deletes existing file, returns false on second call, get returns null", async () => {
      await store.saveProfile(sampleSingleProfile);
      expect(await store.getProfile("test-host", "/projects/alpha")).not.toBeNull();

      // First reset: removes file and returns true
      const resetFirst = await store.deleteProfile("test-host", "/projects/alpha");
      expect(resetFirst).toBe(true);

      // Subsequent get returns null
      const retrieved = await store.getProfile("test-host", "/projects/alpha");
      expect(retrieved).toBeNull();

      // Safe reset on already deleted/nonexistent profile returns false and never throws
      const resetSecond = await store.deleteProfile("test-host", "/projects/alpha");
      expect(resetSecond).toBe(false);

      const resetNonexistent = await store.deleteProfile("test-host", "/never/existed");
      expect(resetNonexistent).toBe(false);
    });

    it("should delete profile and return true when file exists, false when missing", async () => {
      await store.saveProfile(sampleSingleProfile);
      const deletedFirst = await store.deleteProfile("test-host", "/projects/alpha");
      expect(deletedFirst).toBe(true);

      const deletedSecond = await store.deleteProfile("test-host", "/projects/alpha");
      expect(deletedSecond).toBe(false);

      const retrieved = await store.getProfile("test-host", "/projects/alpha");
      expect(retrieved).toBeNull();
    });

    it("should list all profiles for a host", async () => {
      await store.saveProfile(sampleSingleProfile);
      await store.saveProfile(sampleMultiProfile);

      const profiles = await store.listProfiles("test-host");
      expect(profiles).toHaveLength(2);
      const workspaces = profiles.map((p) => p.scope.workspace);
      expect(workspaces).toContain(path.resolve("/projects/alpha"));
      expect(workspaces).toContain(path.resolve("/projects/beta"));
    });
  });
});
