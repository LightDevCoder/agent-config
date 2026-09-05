import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { Profile, ProfileSchema } from "./schema.js";
import { validateProfileAgainstJsonSchema } from "./validator.js";
import { HostCapabilities } from "../adapters/contract.js";

export interface ProfileStoreOptions {
  baseDir?: string;
  fallbackToGlobal?: boolean;
}

export interface GetProfileOptions {
  fallbackToGlobal?: boolean;
}

export interface SaveProfileOptions {
  hostCapabilities?: HostCapabilities;
}

/**
 * Host-scoped and workspace-scoped Profile Store with atomic writes and schema validation.
 */
export class ProfileStore {
  readonly baseDir: string;
  readonly fallbackToGlobal: boolean;

  constructor(options?: ProfileStoreOptions) {
    this.fallbackToGlobal = options?.fallbackToGlobal ?? false;
    if (options?.baseDir) {
      this.baseDir = path.resolve(options.baseDir);
    } else if (process.env.AGENT_CONFIG_PROFILES_DIR) {
      this.baseDir = path.resolve(process.env.AGENT_CONFIG_PROFILES_DIR);
    } else if (process.env.AGENT_CONFIG_HOME) {
      const configHome = path.resolve(process.env.AGENT_CONFIG_HOME);
      this.baseDir =
        path.basename(configHome) === "profiles"
          ? configHome
          : path.join(configHome, "profiles");
    } else {
      this.baseDir = path.join(
        os.homedir(),
        ".config",
        "agent-config",
        "profiles"
      );
    }
  }

  /**
   * Sanitizes a host ID for safe directory naming.
   */
  private sanitizeHostId(hostId: string): string {
    return hostId.replace(/[^a-zA-Z0-9_-]/g, "_") || "unknown";
  }

  /**
   * Computes deterministic file path for a given host_id and workspace.
   */
  getProfilePath(hostId: string, workspace: string): string {
    const safeHost = this.sanitizeHostId(hostId);
    const hostDir = path.join(this.baseDir, safeHost);

    if (workspace === "global") {
      return path.join(hostDir, "global.json");
    }

    const normalizedWorkspace = path.resolve(workspace);
    const workspaceHash = crypto
      .createHash("sha256")
      .update(normalizedWorkspace)
      .digest("hex")
      .slice(0, 16);
    const slug =
      path.basename(normalizedWorkspace).replace(/[^a-zA-Z0-9_-]/g, "_") ||
      "root";

    return path.join(hostDir, `${slug}-${workspaceHash}.json`);
  }

  /**
   * Helper to read, validate, and parse a stored profile file.
   */
  private async readStoredProfile(filePath: string): Promise<Profile | null> {
    if (!fs.existsSync(filePath)) {
      return null;
    }

    const content = await fsp.readFile(filePath, "utf-8");
    let data: unknown;
    try {
      data = JSON.parse(content);
    } catch (err: any) {
      throw new Error(
        `Failed to parse profile JSON at '${filePath}': ${err.message}`
      );
    }

    // Validate against canonical JSON schema
    const validation = validateProfileAgainstJsonSchema(data);
    if (!validation.valid) {
      throw new Error(
        `Stored profile at '${filePath}' failed canonical schema validation:\n${validation.errors?.join("\n")}`
      );
    }

    return ProfileSchema.parse(data);
  }

  /**
   * Reads and validates stored profile.
   * Explicit lookup precedence: Project profile -> Global profile (if fallback policy enabled or requested) -> null.
   */
  async getProfile(
    hostId: string,
    workspace: string,
    options?: GetProfileOptions
  ): Promise<Profile | null> {
    if (workspace === "global") {
      return this.readStoredProfile(this.getProfilePath(hostId, "global"));
    }

    // 1. Check project profile
    const projectPath = this.getProfilePath(hostId, workspace);
    const projectProfile = await this.readStoredProfile(projectPath);
    if (projectProfile) {
      return projectProfile;
    }

    // 2. Check global profile if fallback policy enabled or requested
    const shouldFallback = options?.fallbackToGlobal ?? this.fallbackToGlobal;
    if (shouldFallback) {
      const globalPath = this.getProfilePath(hostId, "global");
      const globalProfile = await this.readStoredProfile(globalPath);
      if (globalProfile) {
        return globalProfile;
      }
    }

    // 3. Missing
    return null;
  }

  /**
   * Atomically saves a profile after full schema and host inventory validation.
   */
  async saveProfile(
    profile: Profile,
    options?: SaveProfileOptions
  ): Promise<void> {
    // 1. Validate against canonical JSON schema
    const validation = validateProfileAgainstJsonSchema(profile);
    if (!validation.valid) {
      throw new Error(
        `Profile failed canonical schema validation:\n${validation.errors?.join("\n")}`
      );
    }

    // 2. Validate via Zod schema (checks conditional single/multi model rules)
    const parsedProfile = ProfileSchema.parse(profile);

    // 3. Scope validation
    if (!parsedProfile.scope || !parsedProfile.scope.workspace) {
      throw new Error("Profile scope must specify a non-empty workspace path");
    }
    if (!parsedProfile.host || !parsedProfile.host.id || !parsedProfile.host.adapter) {
      throw new Error("Profile host binding must specify both id and adapter");
    }

    // 4. Host inventory and effort values validation against host capabilities if provided
    if (options?.hostCapabilities) {
      this.validateAgainstHostCapabilities(
        parsedProfile,
        options.hostCapabilities
      );
    }

    // 5. Atomic write: write to temp file then rename
    const targetPath = this.getProfilePath(
      parsedProfile.host.id,
      parsedProfile.scope.workspace
    );
    const targetDir = path.dirname(targetPath);

    await fsp.mkdir(targetDir, { recursive: true });

    const randomSuffix = crypto.randomBytes(6).toString("hex");
    const tempPath = path.join(
      targetDir,
      `.${path.basename(targetPath)}.tmp.${Date.now()}.${randomSuffix}`
    );

    try {
      await fsp.writeFile(
        tempPath,
        JSON.stringify(parsedProfile, null, 2),
        "utf-8"
      );
      await fsp.rename(tempPath, targetPath);
    } catch (err) {
      try {
        if (fs.existsSync(tempPath)) {
          await fsp.unlink(tempPath);
        }
      } catch {
        // Ignore temp file cleanup failure
      }
      throw err;
    }
  }

  /**
   * Validates profile models and effort values against host capabilities inventory.
   */
  private validateAgainstHostCapabilities(
    profile: Profile,
    hostCaps: HostCapabilities
  ): void {
    if (hostCaps.available_models && hostCaps.available_models.length > 0) {
      const availableSet = new Set(
        hostCaps.available_models
          .filter((m) => m.state === "available")
          .map((m) => m.id)
      );

      if (profile.model_mode === "single" && profile.single_model) {
        if (!availableSet.has(profile.single_model.model)) {
          throw new Error(
            `Model '${profile.single_model.model}' is not available on host '${hostCaps.host_id}'`
          );
        }
      } else if (profile.model_mode === "multi" && profile.tiers) {
        const tierNames = ["routine", "standard", "high", "review"] as const;
        for (const tier of tierNames) {
          const modelId = profile.tiers[tier]?.model;
          if (modelId && !availableSet.has(modelId)) {
            throw new Error(
              `Model '${modelId}' for tier '${tier}' is not available on host '${hostCaps.host_id}'`
            );
          }
        }
      }
    }

    if (
      hostCaps.supported_effort_values &&
      hostCaps.supported_effort_values.length > 0
    ) {
      const supportedSet = new Set(hostCaps.supported_effort_values);

      const checkEffort = (
        effort: { policy?: string; value?: string } | undefined,
        context: string
      ) => {
        if (effort && "value" in effort && effort.value) {
          if (!supportedSet.has(effort.value)) {
            throw new Error(
              `Effort value '${effort.value}' for ${context} is not supported by host (supported: ${hostCaps.supported_effort_values.join(", ")})`
            );
          }
        }
      };

      if (profile.model_mode === "single" && profile.single_model) {
        checkEffort(
          profile.single_model.execution_effort,
          "single-model execution effort"
        );
        checkEffort(
          profile.single_model.review_effort,
          "single-model review effort"
        );
      } else if (profile.model_mode === "multi" && profile.tiers) {
        const tierNames = ["routine", "standard", "high", "review"] as const;
        for (const tier of tierNames) {
          checkEffort(profile.tiers[tier]?.effort, `tier '${tier}'`);
        }
      }
    }
  }

  /**
   * Deletes a stored profile. Returns true if removed, false if not found.
   */
  async deleteProfile(hostId: string, workspace: string): Promise<boolean> {
    const filePath = this.getProfilePath(hostId, workspace);
    if (!fs.existsSync(filePath)) {
      return false;
    }

    await fsp.unlink(filePath);
    return true;
  }

  /**
   * Lists all stored profiles for a host, or all hosts if omitted.
   */
  async listProfiles(hostId?: string): Promise<Profile[]> {
    const results: Profile[] = [];

    if (!fs.existsSync(this.baseDir)) {
      return results;
    }

    const hostDirs = hostId
      ? [this.sanitizeHostId(hostId)]
      : await fsp.readdir(this.baseDir);

    for (const dirName of hostDirs) {
      const fullDir = path.join(this.baseDir, dirName);
      try {
        const stat = await fsp.stat(fullDir);
        if (!stat.isDirectory()) continue;
      } catch {
        continue;
      }

      const files = await fsp.readdir(fullDir);
      for (const file of files) {
        if (file.startsWith(".") || !file.endsWith(".json")) continue;
        const filePath = path.join(fullDir, file);
        try {
          const content = await fsp.readFile(filePath, "utf-8");
          const data = JSON.parse(content);
          if (validateProfileAgainstJsonSchema(data).valid) {
            results.push(ProfileSchema.parse(data));
          }
        } catch {
          // Ignore invalid/unreadable files in list
        }
      }
    }

    return results;
  }
}
