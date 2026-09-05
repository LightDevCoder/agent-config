import fs from "node:fs";
import fsp from "node:fs/promises";
import crypto from "node:crypto";
import { ConfigurationRenderResult } from "../adapters/contract.js";

export interface StoredPreview {
  preview_id: string;
  preview_hash: string;
  workspace: string;
  config: unknown;
  diff: string;
  mutation_targets: string[];
  target: string;
  baseline_hash: string | null;
  target_hashes: Record<string, string | null>;
  rendered: ConfigurationRenderResult;
  created_at: string;
  expires_at?: string;
  applied: boolean;
}

export interface PreviewValidationResult {
  valid: boolean;
  error?: string;
  preview?: StoredPreview;
}

export class PreviewManager {
  private previews: Map<string, StoredPreview> = new Map();

  /**
   * Computes SHA-256 hash of a file if it exists, or null if it does not.
   */
  private async hashFile(filePath: string): Promise<string | null> {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    try {
      const content = await fsp.readFile(filePath);
      return crypto.createHash("sha256").update(content).digest("hex");
    } catch {
      return null;
    }
  }

  /**
   * Creates and registers a new preview snapshot with target file hashes and preview_hash.
   */
  async createPreview(
    workspace: string,
    renderResult: ConfigurationRenderResult,
    config: unknown
  ): Promise<StoredPreview> {
    const targetHashes: Record<string, string | null> = {};
    for (const target of renderResult.mutation_targets) {
      targetHashes[target] = await this.hashFile(target);
    }

    const previewHash = crypto
      .createHash("sha256")
      .update(renderResult.diff + JSON.stringify(renderResult.mutation_targets))
      .digest("hex");

    const createdAt = new Date();
    // 15 minutes TTL
    const expiresAt = new Date(createdAt.getTime() + 15 * 60 * 1000).toISOString();

    const target = renderResult.mutation_targets[0] || workspace;
    const baselineHash = renderResult.mutation_targets[0]
      ? targetHashes[renderResult.mutation_targets[0]]
      : null;

    const preview: StoredPreview = {
      preview_id: renderResult.preview_id,
      preview_hash: `sha256-${previewHash}`,
      workspace,
      config,
      diff: renderResult.diff,
      mutation_targets: renderResult.mutation_targets,
      target,
      baseline_hash: baselineHash,
      target_hashes: targetHashes,
      rendered: renderResult,
      created_at: createdAt.toISOString(),
      expires_at: expiresAt,
      applied: false,
    };

    this.previews.set(preview.preview_id, preview);
    return preview;
  }

  /**
   * Retrieves a stored preview by ID.
   */
  getPreview(previewId: string): StoredPreview | undefined {
    return this.previews.get(previewId);
  }

  /**
   * Validates that a preview exists, has not expired, has not been applied, and targets have not drifted.
   */
  async validatePreview(
    previewId: string,
    workspace?: string
  ): Promise<PreviewValidationResult> {
    const preview = this.previews.get(previewId);
    if (!preview) {
      return {
        valid: false,
        error: `Preview ID '${previewId}' not found or has expired. Please run preview_configuration first.`,
      };
    }

    if (preview.applied) {
      return {
        valid: false,
        error: `Preview ID '${previewId}' has already been applied. Please generate a new preview.`,
      };
    }

    if (preview.expires_at) {
      const now = new Date().getTime();
      const expiry = new Date(preview.expires_at).getTime();
      if (now > expiry) {
        return {
          valid: false,
          error: `Preview ID '${previewId}' not found or has expired. Please generate a new preview.`,
        };
      }
    }

    if (workspace && preview.workspace !== workspace) {
      return {
        valid: false,
        error: `Workspace mismatch: preview was created for '${preview.workspace}' but requested for '${workspace}'`,
      };
    }

    // Verify target file states have not changed since preview was taken
    for (const target of preview.mutation_targets) {
      const currentHash = await this.hashFile(target);
      const originalHash = preview.target_hashes[target];

      if (currentHash !== originalHash) {
        return {
          valid: false,
          error: `Target file '${target}' has changed since preview was generated. Refusing to apply stale preview. Please generate a new preview.`,
        };
      }
    }

    return {
      valid: true,
      preview,
    };
  }

  /**
   * Marks a preview as applied.
   */
  markApplied(previewId: string): void {
    const preview = this.previews.get(previewId);
    if (preview) {
      preview.applied = true;
    }
  }

  /**
   * Clears stored previews.
   */
  clear(): void {
    this.previews.clear();
  }
}
