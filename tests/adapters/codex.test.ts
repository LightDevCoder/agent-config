import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parse } from "smol-toml";
import { updateRootString } from "../../src/adapters/codex/toml.js";
import { CodexAdapter } from "../../src/adapters/codex/index.js";
import { ExecutionConfig } from "../../src/profile/schema.js";

describe("Codex Native Adapter Hardening Tests (§25, §26, §74)", () => {
  let tempDir: string;
  let workspaceDir: string;
  let userHomeDir: string;
  let codexHomeDir: string;
  let originalEnv: {
    HOME?: string;
    CODEX_HOME?: string;
    CODEX_THREAD_ID?: string;
    CODEX_SESSION_ID?: string;
    CODEX_SUBAGENTS?: string;
    CODEX_MAX_CONCURRENCY?: string;
  };

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "codex-hardening-test-"));
    workspaceDir = path.join(tempDir, "workspace");
    userHomeDir = path.join(tempDir, "home");
    codexHomeDir = path.join(userHomeDir, ".codex");
    await fsp.mkdir(workspaceDir, { recursive: true });
    await fsp.mkdir(codexHomeDir, { recursive: true });

    originalEnv = {
      HOME: process.env.HOME,
      CODEX_HOME: process.env.CODEX_HOME,
      CODEX_THREAD_ID: process.env.CODEX_THREAD_ID,
      CODEX_SESSION_ID: process.env.CODEX_SESSION_ID,
      CODEX_SUBAGENTS: process.env.CODEX_SUBAGENTS,
      CODEX_MAX_CONCURRENCY: process.env.CODEX_MAX_CONCURRENCY,
    };

    process.env.HOME = userHomeDir;
    process.env.CODEX_HOME = codexHomeDir;
    delete process.env.CODEX_THREAD_ID;
    delete process.env.CODEX_SESSION_ID;
    delete process.env.CODEX_SUBAGENTS;
    delete process.env.CODEX_MAX_CONCURRENCY;
  });

  afterEach(async () => {
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v === undefined) delete (process.env as any)[k];
      else (process.env as any)[k] = v;
    }

    if (fs.existsSync(tempDir)) {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  describe("Real Inspection & Strict Unknown Semantics (§25)", () => {
    it("reports unknown for unconfirmed capabilities in clean unconfigured workspace", async () => {
      const adapter = new CodexAdapter();
      const caps = await adapter.inspectCapabilities(workspaceDir);

      expect(caps.host_id).toBe("codex");
      expect(caps.capabilities.subagents.state).toBe("unknown");
      expect(caps.capabilities.threads.state).toBe("unknown");
      expect(caps.capabilities.parallelism.state).toBe("unknown");
      expect(caps.capabilities.concurrency?.state).toBe("unknown");
      expect(caps.capabilities.model_selection.state).toBe("unknown");
      expect(caps.capabilities.per_agent_model_selection?.state).toBe("unknown");
      expect(caps.capabilities.reasoning?.state).toBe("unknown");
      expect(caps.supported_effort_values).toEqual([]);

      const topology = await adapter.inspectExecutionTopologyCapabilities(workspaceDir);
      expect(topology.supports_subagents).toBe(false);
      expect(topology.supports_multi_agent).toBe(false);
      expect(topology.supports_parallel_execution).toBe(false);
    });

    it("detects subagent and thread capabilities when evidenced on host", async () => {
      const agentsDir = path.join(workspaceDir, ".codex", "agents");
      const sessionsDir = path.join(workspaceDir, ".codex", "sessions");
      await fsp.mkdir(agentsDir, { recursive: true });
      await fsp.mkdir(sessionsDir, { recursive: true });

      const adapter = new CodexAdapter();
      const caps = await adapter.inspectCapabilities(workspaceDir);

      expect(caps.capabilities.subagents.state).toBe("available");
      expect(caps.capabilities.subagents.evidence?.locator).toBe(agentsDir);
      expect(caps.capabilities.threads.state).toBe("available");
      expect(caps.capabilities.threads.evidence?.locator).toBe(sessionsDir);

      const topology = await adapter.inspectExecutionTopologyCapabilities(workspaceDir);
      expect(topology.supports_subagents).toBe(true);
      expect(topology.supports_multi_agent).toBe(true);
    });

    it("detects models and supported reasoning values when evidenced in config.toml", async () => {
      const codexDir = path.join(workspaceDir, ".codex");
      await fsp.mkdir(codexDir, { recursive: true });
      await fsp.writeFile(
        path.join(codexDir, "config.toml"),
        'model = "gpt-5.6-sol"\nsupported_effort_values = ["low", "medium", "high", "xhigh"]\nmax_concurrency = 4\n',
        "utf-8"
      );

      const adapter = new CodexAdapter();
      const caps = await adapter.inspectCapabilities(workspaceDir);

      expect(caps.capabilities.model_selection.state).toBe("available");
      expect(caps.capabilities.concurrency?.state).toBe("available");
      expect(caps.capabilities.concurrency?.max_concurrency).toBe(4);
      expect(caps.capabilities.parallelism.state).toBe("available");
      expect(caps.capabilities.reasoning?.state).toBe("available");
      expect(caps.supported_effort_values).toEqual(["low", "medium", "high", "xhigh"]);
    });
  });

  describe("Root TOML and ordered effort regressions", () => {
    it("preserves named profiles and validates only root settings", async () => {
      const adapter = new CodexAdapter();
      const configPath = path.join(workspaceDir, ".codex", "config.toml");
      await fsp.mkdir(path.dirname(configPath), { recursive: true });
      const profile = '[profiles.personal]\nmodel = "keep-me"\nmodel_reasoning_effort = "low"\n';
      await fsp.writeFile(configPath, profile);
      const plan = { execution: { model: "keep-me", effort: "low" } } as ExecutionConfig;
      expect((await adapter.validateConfiguration(plan, workspaceDir)).valid).toBe(false);
      const rendered = await adapter.renderConfiguration(plan, undefined, workspaceDir);
      expect(rendered.files![0].content).toContain(profile);
      expect(parse(rendered.files![0].content).model).toBe("keep-me");
      await adapter.applyConfiguration(rendered.preview_id, rendered, workspaceDir);
      expect((await adapter.validateConfiguration(plan, workspaceDir)).valid).toBe(true);
    });

    it.each([
      '# retained\n"model" = "old"\n[profiles.personal]\nmodel = "keep"\n',
      "note = '''\nmodel = \"inside-string\"\n[fake-table]\n'''\nmodel = 'old'\n[actual]\nkeep = true\n",
      'values = [\n  "[fake]",\n]\nmodel = "old"\n',
      'model = """old\nmultiline"""\n[actual]\nkeep = true\n',
    ])("updates only the real root value in %s", (content) => {
      const before = parse(content);
      const updated = updateRootString(content, "model", 'new\\path"quoted');
      expect(parse(updated)).toEqual({ ...before, model: 'new\\path"quoted' });
    });

    it("rejects malformed TOML before rendering a write", () => {
      expect(() => updateRootString('model = "unterminated', "model", "new")).toThrow();
    });

    it.each([["low", "high", "max"], ["low", "high", "xhigh", "max"], ["standard", "deep"]])(
      "resolves the last evidenced level for %j", async (...levels) => {
        const configPath = path.join(workspaceDir, ".codex", "config.toml");
        await fsp.mkdir(path.dirname(configPath), { recursive: true });
        await fsp.writeFile(configPath, `supported_effort_values = ${JSON.stringify(levels)}\n`);
        expect(await new CodexAdapter().resolveReasoningPolicy("highest-supported", undefined, workspaceDir))
          .toEqual({ host_field: "model_reasoning_effort", host_value: levels.at(-1) });
      }
    );
  });

  describe("Apply Validation: Decomposed Worker Model & Reasoning Effort (§74)", () => {
    const decomposedPlan: ExecutionConfig = {
      task_shape: "decomposed",
      model_mode: "multi",
      readiness: "executable",
      topology: {
        type: "controller-workers",
        concurrency: 2,
        fresh_contexts: true,
        subagent_contexts: true,
      },
      controller: {
        model: "gpt-5.6-sol",
        effort: "high",
        context: "main-session",
      },
      work_items: [
        {
          ticket_id: "01-init",
          difficulty: "routine",
          model: "gpt-5.6-luna",
          effort: "low",
          context: "worker-1",
        },
        {
          ticket_id: "02-core",
          difficulty: "demanding",
          model: "gpt-5.6-terra",
          effort: "xhigh",
          context: "worker-2",
        },
      ],
      review: {
        strategy: "independent-review",
        model: "gpt-5.6-sol",
        effort: "high",
        context: "fresh-session",
      },
    };

    it("renders, applies, and validates both worker model and worker reasoning effort", async () => {
      const adapter = new CodexAdapter();
      const rendered = await adapter.renderConfiguration(decomposedPlan, undefined, workspaceDir);

      expect(rendered.mutation_targets).toHaveLength(3);
      const applyResult = await adapter.applyConfiguration(rendered.preview_id, rendered, workspaceDir);
      expect(applyResult.success).toBe(true);

      // Verify files content
      const worker1File = path.join(workspaceDir, ".codex", "agents", "01-init.toml");
      const worker2File = path.join(workspaceDir, ".codex", "agents", "02-core.toml");
      expect(fs.existsSync(worker1File)).toBe(true);
      expect(fs.existsSync(worker2File)).toBe(true);

      const worker1Content = await fsp.readFile(worker1File, "utf-8");
      expect(worker1Content).toContain('model = "gpt-5.6-luna"');
      expect(worker1Content).toContain('model_reasoning_effort = "low"');

      const worker2Content = await fsp.readFile(worker2File, "utf-8");
      expect(worker2Content).toContain('model = "gpt-5.6-terra"');
      expect(worker2Content).toContain('model_reasoning_effort = "xhigh"');

      // Validate post-apply state
      const validation = await adapter.validateConfiguration(decomposedPlan, workspaceDir);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toBeUndefined();
    });

    it("detects drift when worker reasoning effort is tampered or deleted (§74)", async () => {
      const adapter = new CodexAdapter();
      const rendered = await adapter.renderConfiguration(decomposedPlan, undefined, workspaceDir);
      await adapter.applyConfiguration(rendered.preview_id, rendered, workspaceDir);

      // 1. Tamper worker reasoning effort
      const worker1File = path.join(workspaceDir, ".codex", "agents", "01-init.toml");
      await fsp.writeFile(
        worker1File,
        'name = "01-init"\nmodel = "gpt-5.6-luna"\nmodel_reasoning_effort = "high"\n',
        "utf-8"
      );

      const tamperedValidation = await adapter.validateConfiguration(decomposedPlan, workspaceDir);
      expect(tamperedValidation.valid).toBe(false);
      expect(
        tamperedValidation.errors?.some((e) =>
          e.includes("reasoning effort mismatch")
        )
      ).toBe(true);

      // 2. Delete worker reasoning effort completely
      await fsp.writeFile(
        worker1File,
        'name = "01-init"\nmodel = "gpt-5.6-luna"\n',
        "utf-8"
      );

      const deletedEffortValidation = await adapter.validateConfiguration(decomposedPlan, workspaceDir);
      expect(deletedEffortValidation.valid).toBe(false);
      expect(
        deletedEffortValidation.errors?.some((e) =>
          e.includes("reasoning effort mismatch")
        )
      ).toBe(true);
    });

    it("detects drift when worker model is tampered", async () => {
      const adapter = new CodexAdapter();
      const rendered = await adapter.renderConfiguration(decomposedPlan, undefined, workspaceDir);
      await adapter.applyConfiguration(rendered.preview_id, rendered, workspaceDir);

      const worker2File = path.join(workspaceDir, ".codex", "agents", "02-core.toml");
      await fsp.writeFile(
        worker2File,
        'name = "02-core"\nmodel = "wrong-model"\nmodel_reasoning_effort = "xhigh"\n',
        "utf-8"
      );

      const validation = await adapter.validateConfiguration(decomposedPlan, workspaceDir);
      expect(validation.valid).toBe(false);
      expect(
        validation.errors?.some((e) =>
          e.includes("model mismatch")
        )
      ).toBe(true);
    });
  });

  describe("User vs Project Scope for MCP Registration and Config (§26)", () => {
    it("manages companion registration in project scope", async () => {
      const adapter = new CodexAdapter();
      const preview = await adapter.previewCompanionRegistration(workspaceDir, "project");

      expect(preview.mutation_targets).toEqual([
        path.join(workspaceDir, ".codex", "config.toml"),
      ]);
      expect(preview.diff).toContain("[mcp_servers.agent-config]");

      const apply = await adapter.applyCompanionRegistration(preview.preview_hash!, workspaceDir);
      expect(apply.success).toBe(true);

      const status = await adapter.inspectCompanionRegistration(workspaceDir, "project");
      expect(status.registered).toBe(true);
      expect(status.target_file).toBe(path.join(workspaceDir, ".codex", "config.toml"));
      expect(status.command).toBe("agent-config");
    });

    it("manages companion registration in user scope without touching workspace", async () => {
      const adapter = new CodexAdapter();
      const preview = await adapter.previewCompanionRegistration(undefined, "user");

      expect(preview.mutation_targets).toEqual([
        path.join(codexHomeDir, "config.toml"),
      ]);
      expect(preview.diff).toContain("[mcp_servers.agent-config]");

      const apply = await adapter.applyCompanionRegistration(preview.preview_hash!, undefined);
      expect(apply.success).toBe(true);

      // User scope is registered
      const userStatus = await adapter.inspectCompanionRegistration(undefined, "user");
      expect(userStatus.registered).toBe(true);
      expect(userStatus.command).toBe("agent-config");

      // Workspace remains untouched
      expect(fs.existsSync(path.join(workspaceDir, ".codex", "config.toml"))).toBe(false);
    });

    it("inspectCompanionRegistration falls back from project to user scope when workspace is unregistered", async () => {
      // Register in user scope only via TOML
      await fsp.writeFile(
        path.join(codexHomeDir, "config.toml"),
        '[mcp_servers.agent-config]\ncommand = "agent-config"\nargs = ["serve"]\n',
        "utf-8"
      );

      const adapter = new CodexAdapter();
      // Inspecting workspace falls back to effective user registration
      const status = await adapter.inspectCompanionRegistration(workspaceDir);
      expect(status.registered).toBe(true);
      expect(status.target_file).toBe(path.join(codexHomeDir, "config.toml"));
      expect(status.command).toBe("agent-config");
    });
  });
});
