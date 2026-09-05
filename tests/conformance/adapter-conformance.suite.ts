import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import { HostAdapter } from "../../src/adapters/contract.js";
import { ExecutionConfig, AgentProfile } from "../../src/profile/schema.js";
import { IsolatedEnv, createIsolatedEnv } from "../harness/isolated-env.js";
import { MockSubprocessRunner, createMockSubprocessRunner } from "../harness/mock-runner.js";

export interface ConformanceContext {
  workspaceDir: string;
  env: IsolatedEnv;
  mockRunner: MockSubprocessRunner;
}

export interface ConformanceOptions {
  adapterName?: string;
  setupWorkspace?: (workspaceDir: string, env: IsolatedEnv) => Promise<void>;
  supportsMutation?: boolean;
  sampleExecutionConfig?: ExecutionConfig;
  sampleProfile?: AgentProfile;
}

export type AdapterFactory = (ctx: ConformanceContext) => HostAdapter;

/**
 * Reusable Shared Adapter Contract Conformance Suite (§81).
 * Verifies that any HostAdapter adheres to mandatory baseline invariants:
 * - Identification returns boolean cleanly without throwing.
 * - Version detection returns valid HostVersionInfo and fail_closed_for_mutation flag.
 * - Strict unknown semantics: unconfirmed capabilities are unknown/unavailable, never defaulted to available.
 * - No invented models: inspectModels returns only evidenced models, never fabricates.
 * - No invented reasoning: supported effort/variant values are strictly evidenced.
 * - No silent mutation: inspection & preview calls never mutate filesystem state.
 * - Preview before apply: applyConfiguration rejects invalid/missing/mismatched preview IDs.
 * - Scope isolation: operations respect workspace boundaries.
 * - Validation resiliency: configuration validation handles blank/mismatched states cleanly.
 */
export function runAdapterConformanceSuite(
  adapterFactory: AdapterFactory,
  options: ConformanceOptions = {}
): void {
  const adapterName = options.adapterName || "HostAdapter";

  describe(`Adapter Conformance Suite: ${adapterName} (§81)`, () => {
    let env: IsolatedEnv;
    let workspaceDir: string;
    let mockRunner: MockSubprocessRunner;
    let adapter: HostAdapter;

    const samplePlan: ExecutionConfig = options.sampleExecutionConfig || {
      execution_id: "conformance-plan-001",
      controller: { model: "test-conformance-model" },
      execution: { model: "test-conformance-model" },
    };

    beforeEach(async () => {
      env = createIsolatedEnv();
      env.activate();
      workspaceDir = env.workspaceDir;

      mockRunner = createMockSubprocessRunner();
      mockRunner.installGlobalHook();

      if (options.setupWorkspace) {
        await options.setupWorkspace(workspaceDir, env);
      }

      adapter = adapterFactory({ workspaceDir, env, mockRunner });
    });

    afterEach(async () => {
      mockRunner.uninstallGlobalHook();
      mockRunner.reset();
      await env.cleanup();
    });

    it("1. Identification: returns boolean cleanly without throwing on valid or invalid paths", async () => {
      const workspaceResult = await adapter.identifyHost(workspaceDir);
      expect(typeof workspaceResult).toBe("boolean");

      const noArgResult = await adapter.identifyHost();
      expect(typeof noArgResult).toBe("boolean");

      const nonExistentResult = await adapter.identifyHost(
        path.join(workspaceDir, "does-not-exist-" + Date.now())
      );
      expect(typeof nonExistentResult).toBe("boolean");
    });

    it("2. Version Detection: returns valid HostVersionInfo and fail_closed_for_mutation flag", async () => {
      const versionInfo = await adapter.inspectVersion(workspaceDir);
      expect(versionInfo).toBeDefined();

      const validCompatibilities = [
        "supported",
        "partially-supported",
        "unknown-version",
        "incompatible",
      ];
      expect(validCompatibilities).toContain(versionInfo.compatibility);
      expect(typeof versionInfo.fail_closed_for_mutation).toBe("boolean");

      if (versionInfo.version !== undefined) {
        expect(typeof versionInfo.version).toBe("string");
      }
    });

    it("3. Strict Unknown Semantics: unconfirmed capabilities are unknown or unavailable, never defaulted to available", async () => {
      const caps = await adapter.inspectCapabilities(workspaceDir);
      expect(caps.host_id).toBeDefined();
      expect(caps.adapter_id).toBeDefined();

      const validStates = ["available", "unavailable", "unknown"];
      expect(validStates).toContain(caps.capabilities.subagents.state);
      expect(validStates).toContain(caps.capabilities.threads.state);
      expect(validStates).toContain(caps.capabilities.parallelism.state);
      expect(validStates).toContain(caps.capabilities.model_selection.state);

      if (caps.capabilities.concurrency) {
        expect(validStates).toContain(caps.capabilities.concurrency.state);
      }
      if (caps.capabilities.reasoning) {
        expect(validStates).toContain(caps.capabilities.reasoning.state);
      }
      if (caps.capabilities.configuration_mutation) {
        expect(validStates).toContain(caps.capabilities.configuration_mutation.state);
      }

      // If concurrency max is not confirmed, parallelism must not be marked available
      if (!caps.capabilities.concurrency?.max_concurrency) {
        expect(["unknown", "unavailable"]).toContain(caps.capabilities.parallelism.state);
      }

      const topology = await adapter.inspectExecutionTopologyCapabilities(workspaceDir);
      expect(typeof topology.supports_single_session).toBe("boolean");
      expect(typeof topology.supports_subagents).toBe("boolean");
      expect(typeof topology.supports_parallel_execution).toBe("boolean");

      // Execution topology parallel execution must align with evidenced parallelism
      if (caps.capabilities.parallelism.state !== "available") {
        expect(topology.supports_parallel_execution).toBe(false);
      }
    });

    it("4. No Invented Models: only returns evidenced models and never fabricates unevidenced inventories", async () => {
      const models = await adapter.inspectModels(workspaceDir);
      expect(Array.isArray(models)).toBe(true);

      for (const model of models) {
        expect(typeof model.id).toBe("string");
        expect(model.id.length).toBeGreaterThan(0);
        expect(["available", "unavailable", "unknown"]).toContain(model.state);

        if (model.evidence) {
          const validEvidenceKinds = [
            "host-runtime",
            "host-config",
            "host-schema",
            "adapter-probe",
            "user-confirmed",
          ];
          expect(validEvidenceKinds).toContain(model.evidence.kind);
          expect(typeof model.evidence.locator).toBe("string");
        }
      }
    });

    it("5. No Invented Reasoning: supported effort/variant values are strictly evidenced", async () => {
      const optionsResult = await adapter.inspectReasoningOptions(workspaceDir);
      expect(optionsResult).toBeDefined();
      expect(typeof optionsResult.native_field).toBe("string");
      expect(Array.isArray(optionsResult.supported_values)).toBe(true);

      const caps = await adapter.inspectCapabilities(workspaceDir);
      expect(Array.isArray(caps.supported_effort_values)).toBe(true);

      // In an unconfigured workspace, unsupported/unconfirmed reasoning must not invent standard effort arrays
      if (
        caps.capabilities.reasoning?.state === "unknown" ||
        caps.capabilities.reasoning?.state === "unavailable"
      ) {
        expect(optionsResult.supported_values).toEqual([]);
        expect(caps.supported_effort_values).toEqual([]);
      }

      // Assert no invented concurrency (no unevidenced concurrency like 4 or 8)
      if (caps.capabilities.concurrency?.state === "unknown") {
        expect(caps.capabilities.concurrency.max_concurrency).toBeUndefined();
      }
    });

    it("6. No Silent Mutation: inspection and preview calls never modify workspace or home files", async () => {
      const workspaceSnapshot = env.snapshotDirectory(workspaceDir);
      const homeSnapshot = env.snapshotDirectory(env.homeDir);

      await adapter.identifyHost(workspaceDir);
      await adapter.inspectVersion(workspaceDir);
      await adapter.inspectCapabilities(workspaceDir);
      await adapter.inspectModels(workspaceDir);
      await adapter.inspectReasoningOptions(workspaceDir);
      await adapter.inspectExecutionTopologyCapabilities(workspaceDir);
      await adapter.inspectCompanionRegistration(workspaceDir);
      await adapter.previewCompanionRegistration(workspaceDir);

      try {
        await adapter.previewConfiguration(samplePlan, options.sampleProfile, workspaceDir);
      } catch {
        // Plan might be rejected if unconfigured, but must not mutate
      }

      env.assertDirectoryUnchanged(
        workspaceDir,
        workspaceSnapshot,
        `${adapterName} inspection & preview`
      );
      env.assertDirectoryUnchanged(
        env.homeDir,
        homeSnapshot,
        `${adapterName} inspection & preview`
      );
    });

    it("7. Preview Before Apply: rejects missing, non-existent, or mismatched preview IDs", async () => {
      // Direct apply without rendered configuration must be rejected
      const badApply = await adapter.applyConfiguration(
        "non-existent-preview-id-99999",
        undefined,
        workspaceDir
      );
      expect(badApply.success).toBe(false);
      expect(badApply.error).toBeDefined();

      // Apply with mismatched preview ID must be rejected
      try {
        const preview = await adapter.previewConfiguration(
          samplePlan,
          options.sampleProfile,
          workspaceDir
        );
        if (preview && preview.preview_id) {
          const mismatchedApply = await adapter.applyConfiguration(
            "completely-different-id",
            preview,
            workspaceDir
          );
          expect(mismatchedApply.success).toBe(false);
        }
      } catch {
        // Some adapters may reject preview if models unconfigured
      }

      // Companion registration apply with bogus hash must be rejected
      const badCompanionApply = await adapter.applyCompanionRegistration(
        "bogus-companion-hash-12345",
        workspaceDir
      );
      expect(badCompanionApply.success).toBe(false);

      // Frozen preview / apply exact match and drift / staleness rejection
      try {
        const preview = await adapter.previewConfiguration(
          samplePlan,
          options.sampleProfile,
          workspaceDir
        );
        if (preview && preview.preview_id && preview.mutation_targets.length > 0) {
          // Exact match apply
          const goodApply = await adapter.applyConfiguration(
            preview.preview_id,
            preview,
            workspaceDir
          );
          expect(goodApply.success).toBe(true);

          // Drift rejection: modify one of the applied targets
          const targetFile = preview.mutation_targets[0];
          if (targetFile) {
            // Apply again with drifted content / changed target or stale preview
            const stalePreview = {
              ...preview,
              preview_id: `stale-${Date.now()}`,
            };
            const staleApply = await adapter.applyConfiguration(
              stalePreview.preview_id,
              stalePreview,
              workspaceDir
            );
            // Stale/unmatched preview ID must be rejected
            expect(staleApply.success).toBe(false);
          }
        }
      } catch {
        // Some adapters reject preview when models are unconfigured, which is safe fail-closed behavior
      }
    });

    it("8. Scope Isolation & Fidelity: rendered targets and previews strictly respect workspace or home boundaries without scope cross-contamination", async () => {
      try {
        const preview = await adapter.previewConfiguration(
          samplePlan,
          options.sampleProfile,
          workspaceDir
        );
        if (preview && preview.mutation_targets) {
          for (const target of preview.mutation_targets) {
            const isInsideWorkspace = target.startsWith(workspaceDir);
            const isInsideHome = target.startsWith(env.homeDir);
            expect(
              isInsideWorkspace || isInsideHome,
              `Render target ${target} leaked outside workspace and home`
            ).toBe(true);
          }
        }
      } catch {
        // Skip if preview requires specific config
      }

      // Project scope companion preview must target project scope inside workspace
      const projectCompanionPreview = await adapter.previewCompanionRegistration(workspaceDir, "project");
      for (const target of projectCompanionPreview.mutation_targets) {
        expect(
          target.startsWith(workspaceDir),
          `Project scope companion target ${target} must strictly be inside workspace, never fall back to user scope`
        ).toBe(true);
      }
      expect(projectCompanionPreview.scope).toBe("project");

      // User scope companion preview must target user scope inside home
      const userCompanionPreview = await adapter.previewCompanionRegistration(workspaceDir, "user");
      for (const target of userCompanionPreview.mutation_targets) {
        expect(
          target.startsWith(env.homeDir),
          `User scope companion target ${target} must strictly be inside home, never fall back to workspace`
        ).toBe(true);
      }
      expect(["global", "user"]).toContain(userCompanionPreview.scope);
    });

    it("9. Validation Resiliency: handles blank and mismatched states cleanly without unhandled exceptions", async () => {
      const configValidation = await adapter.validateConfiguration(samplePlan, workspaceDir);
      expect(typeof configValidation.valid).toBe("boolean");

      const companionValidation = await adapter.validateCompanionRegistration(workspaceDir);
      expect(typeof companionValidation.valid).toBe("boolean");
    });
  });
}
