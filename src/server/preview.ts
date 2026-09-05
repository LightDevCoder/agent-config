import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { ConfigurationRenderResult } from "../adapters/contract.js";
import {
  FrozenMutationPreview,
  MutationOperation,
  FileMutationOperation,
  NonFileMutationOperation,
} from "../contracts/index.js";

export interface StoredPreview extends FrozenMutationPreview {
  workspace: string;
  config: unknown;
  diff: string;
  mutation_targets: string[];
  target_hashes: Record<string, string | null>;
  rendered: ConfigurationRenderResult;
  applied: boolean;
  operations?: MutationOperation[];
}

export interface PreviewValidationResult {
  valid: boolean;
  error?: string;
  preview?: StoredPreview;
}

export type TransactionTerminalState =
  | "SUCCESS"
  | "ROLLED_BACK"
  | "PARTIALLY_APPLIED"
  | "REPAIR_REQUIRED";

export interface TransactionApplyResult {
  success: boolean;
  state: TransactionTerminalState;
  applied_targets: string[];
  error?: string;
  diagnostics?: string[];
}

export interface TransactionApplyOptions {
  requireReversibility?: boolean;
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
    config: unknown,
    meta?: {
      adapter_id?: string;
      host_identity?: string;
      host_version?: string;
      scope?: "project" | "user" | "global";
      target?: string;
      operations?: MutationOperation[];
    }
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

    const target = meta?.target || renderResult.mutation_targets[0] || workspace;
    const baselineHash = renderResult.mutation_targets[0]
      ? targetHashes[renderResult.mutation_targets[0]]
      : null;

    // Ordered operations supporting file and non-file/command mutations
    const operations: MutationOperation[] = meta?.operations || [];
    if (operations.length === 0) {
      if (renderResult.files && renderResult.files.length > 0) {
        for (const file of renderResult.files) {
          const bHash = targetHashes[file.path] ?? (await this.hashFile(file.path));
          operations.push({
            type: "file",
            target: file.path,
            action: bHash === null ? "create" : "update",
            diff: renderResult.diff,
            content: file.content,
            baseline_hash: bHash,
            reversible: true,
          });
        }
      } else {
        for (const t of renderResult.mutation_targets) {
          const bHash = targetHashes[t] ?? (await this.hashFile(t));
          operations.push({
            type: "file",
            target: t,
            action: bHash === null ? "create" : "update",
            diff: renderResult.diff,
            baseline_hash: bHash,
            reversible: true,
          });
        }
      }
    }

    const preview: StoredPreview = {
      preview_id: renderResult.preview_id,
      preview_hash: `sha256-${previewHash}`,
      adapter_id: meta?.adapter_id || "unknown",
      host_identity: meta?.host_identity || meta?.adapter_id || "unknown",
      host_version: meta?.host_version,
      scope: meta?.scope || (workspace ? "project" : "global"),
      target,
      baseline_identity: target,
      baseline_hash: baselineHash,
      mutation: {
        diff: renderResult.diff,
        files: renderResult.files,
      },
      operations,
      workspace,
      config,
      diff: renderResult.diff,
      mutation_targets: renderResult.mutation_targets,
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
   * Executes a multi-operation transaction with full preflight checks and compensating rollback.
   * Invariants:
   * 1. Full preflight check across all target baselines before applying any mutation.
   * 2. If an operation has reversible: false and safety semantics require reversibility, preflight fails before execution.
   * 3. Compensating rollback: if operation N fails mid-transaction, operations N-1 down to 0 are rolled back in reverse order.
   * 4. If compensating rollback fails or cannot fully restore state, enter terminal state: PARTIALLY_APPLIED / REPAIR_REQUIRED.
   */
  async executeTransaction(
    preview: StoredPreview,
    options?: TransactionApplyOptions
  ): Promise<TransactionApplyResult> {
    const operations = preview.operations || [];
    const requireReversibility = options?.requireReversibility ?? true;

    // --- STEP 1: PREFLIGHT CHECK ---
    for (const op of operations) {
      // Check reversibility
      if (requireReversibility && op.reversible === false) {
        const targetDesc = op.type === "file" ? op.target : op.description;
        const err: any = new Error(
          `Preflight failed: Operation targeting '${targetDesc}' is marked non-reversible (reversible: false). Reversible safety semantics required.`
        );
        err.name = "PreflightError";
        throw err;
      }

      // Check baseline hash for file operations
      if (op.type === "file") {
        const currentHash = await this.hashFile(op.target);
        if (currentHash !== op.baseline_hash) {
          const err: any = new Error(
            `Preflight failed: Baseline drift detected for target '${op.target}': expected baseline ${op.baseline_hash ?? "null"}, but found ${currentHash ?? "null"}.`
          );
          err.name = "BaselineDriftError";
          throw err;
        }
      }
    }

    // --- STEP 2: EXECUTION WITH COMPENSATING ROLLBACK TRACKING ---
    interface AppliedRollback {
      description: string;
      rollback: () => Promise<void>;
    }
    const appliedRollbacks: AppliedRollback[] = [];
    const appliedTargets: string[] = [];

    for (let i = 0; i < operations.length; i++) {
      const op = operations[i];
      try {
        if (op.type === "file") {
          const existed = fs.existsSync(op.target);
          const priorContent = existed ? await fsp.readFile(op.target, "utf-8") : null;

          if (op.action === "create" || op.action === "update") {
            if (op.content === undefined) {
              throw new Error(`Cannot execute '${op.action}' on file '${op.target}' without content.`);
            }
            await fsp.mkdir(path.dirname(op.target), { recursive: true });
            await fsp.writeFile(op.target, op.content, "utf-8");
            appliedTargets.push(op.target);

            appliedRollbacks.push({
              description: `Restore file '${op.target}'`,
              rollback: async () => {
                if (!existed) {
                  if (fs.existsSync(op.target)) {
                    await fsp.unlink(op.target);
                  }
                } else {
                  await fsp.writeFile(op.target, priorContent!, "utf-8");
                }
              },
            });
          } else if (op.action === "delete") {
            if (existed) {
              await fsp.unlink(op.target);
            }
            appliedTargets.push(op.target);

            appliedRollbacks.push({
              description: `Recreate deleted file '${op.target}'`,
              rollback: async () => {
                if (priorContent !== null) {
                  await fsp.mkdir(path.dirname(op.target), { recursive: true });
                  await fsp.writeFile(op.target, priorContent, "utf-8");
                }
              },
            });
          }
        } else if (op.type === "native" || op.type === "command") {
          appliedTargets.push(op.description);
          if (op.undo_action) {
            appliedRollbacks.push({
              description: `Undo command '${op.description}'`,
              rollback: async () => {
                // Command undo hook if implemented
              },
            });
          }
        }
      } catch (opErr: any) {
        // Operation N failed! Trigger compensating rollback for operations N-1 down to 0
        const diagnostics: string[] = [
          `Operation ${i} failed (${op.type === "file" ? op.target : op.description}): ${opErr.message}`,
        ];
        let rollbackFailed = false;

        for (let r = appliedRollbacks.length - 1; r >= 0; r--) {
          const rb = appliedRollbacks[r];
          try {
            await rb.rollback();
            diagnostics.push(`Compensating rollback succeeded: ${rb.description}`);
          } catch (rbErr: any) {
            rollbackFailed = true;
            diagnostics.push(`Compensating rollback failed: ${rb.description} - ${rbErr.message}`);
          }
        }

        if (rollbackFailed) {
          const terminalErr: any = new Error(
            `Transaction failed and compensating rollback could not restore prior state. Terminal state: PARTIALLY_APPLIED / REPAIR_REQUIRED.\nDiagnostics:\n${diagnostics.join("\n")}`
          );
          terminalErr.terminalState = "PARTIALLY_APPLIED";
          terminalErr.state = "REPAIR_REQUIRED";
          terminalErr.diagnostics = diagnostics;
          throw terminalErr;
        }

        const rollbackErr: any = new Error(
          `Transaction failed at operation ${i}: ${opErr.message}. All ${appliedRollbacks.length} prior operations rolled back successfully.`
        );
        rollbackErr.terminalState = "ROLLED_BACK";
        rollbackErr.diagnostics = diagnostics;
        throw rollbackErr;
      }
    }

    this.markApplied(preview.preview_id);

    return {
      success: true,
      state: "SUCCESS",
      applied_targets: appliedTargets,
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
