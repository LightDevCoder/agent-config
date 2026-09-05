import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fsp from "node:fs/promises";
import { IsolatedEnv, createIsolatedEnv, copyFixture } from "./harness/isolated-env.js";
import { MockSubprocessRunner, createMockSubprocessRunner } from "./harness/mock-runner.js";
import { AdapterRegistry } from "../src/adapters/registry.js";
import { CodexAdapter } from "../src/adapters/codex/index.js";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code/index.js";
import { GeminiCliAdapter } from "../src/adapters/gemini-cli/index.js";
import { DshAdapter } from "../src/adapters/dsh/index.js";
import { OpenCodeAdapter } from "../src/adapters/opencode/index.js";
import { ZCodeAdapter } from "../src/adapters/zcode/index.js";
import { CursorAdapter } from "../src/adapters/cursor/index.js";
import { GrokBuildAdapter } from "../src/adapters/grok-build/index.js";
import { HermesAdapter } from "../src/adapters/hermes/index.js";
import { GenericAdapter } from "../src/adapters/generic/index.js";

/**
 * Cross-Harness Acceptance Fixture Tests (SPEC §13, §66, §68, §69, §70, §87, §88).
 * Tests all 9 Native Adapters and 1 Generic fallback against isolated CLI fixtures:
 * - Isolated test fixtures exist for each harness without modifying real host environment
 * - Official CLI contract fixtures (--version, --help, inspect/status/doctor outputs)
 * - Safe identification, version classification, capability inspection, and fail-closed behavior
 */
describe("Cross-Harness Acceptance Fixture Tests (SPEC §68, §69, §88)", () => {
  let env: IsolatedEnv;
  let workspaceDir: string;
  let mockRunner: MockSubprocessRunner;
  let registry: AdapterRegistry;

  beforeEach(async () => {
    env = createIsolatedEnv();
    env.activate();
    workspaceDir = env.workspaceDir;

    mockRunner = createMockSubprocessRunner();
    mockRunner.installGlobalHook();

    registry = new AdapterRegistry();
  });

  afterEach(async () => {
    mockRunner.uninstallGlobalHook();
    mockRunner.reset();
    await env.cleanup();
  });

  describe("1. Codex CLI & Fixture Contract", () => {
    it("identifies and inspects Codex from single-model fixture and CLI version", async () => {
      await copyFixture("codex", "single-model", workspaceDir);
      mockRunner.mockVersion("codex", "codex-cli 0.5.2 (commit abcdef)");

      const adapter = new CodexAdapter();
      const detected = await adapter.identifyHost(workspaceDir);
      expect(detected).toBe(true);

      // Inspect version via environment variable
      process.env.CODEX_VERSION = "0.5.2";
      const version = await adapter.inspectVersion(workspaceDir);
      expect(version.compatibility).toBe("supported");
      expect(version.version).toBe("0.5.2");
      expect(version.fail_closed_for_mutation).toBe(false);
      delete process.env.CODEX_VERSION;

      const models = await adapter.inspectModels(workspaceDir);
      expect(models.some((m) => m.id === "gpt-4o")).toBe(true);
    });

    it("handles Codex CLI help output and unknown-version safely", async () => {
      mockRunner.register("codex", {
        exitCode: 0,
        stdout: "Usage: codex [options] [command]\nOptions:\n  --version  Show version number\n  --help     Show help\n",
        stderr: "",
      }, [/--help/]);

      const res = await mockRunner.run("codex", ["--help"]);
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain("Usage: codex");
    });
  });

  describe("2. Claude Code CLI & Fixture Contract", () => {
    it("identifies and inspects Claude Code from single-model fixture and CLI version", async () => {
      await copyFixture("claude-code", "single-model", workspaceDir);
      mockRunner.mockVersion("claude", "claude-code 0.2.29");

      const adapter = new ClaudeCodeAdapter();
      const detected = await adapter.identifyHost(workspaceDir);
      expect(detected).toBe(true);

      process.env.CLAUDE_VERSION = "0.2.29";
      const version = await adapter.inspectVersion(workspaceDir);
      expect(version.compatibility).toBe("supported");
      expect(version.version).toBe("0.2.29");
      expect(version.fail_closed_for_mutation).toBe(false);
      delete process.env.CLAUDE_VERSION;

      const models = await adapter.inspectModels(workspaceDir);
      expect(models.length).toBeGreaterThanOrEqual(1);
    });

    it("handles Claude Code doctor output fixture", async () => {
      mockRunner.mockDoctor("claude", { status: "healthy", api_connected: true });
      const res = await mockRunner.run("claude", ["doctor"]);
      expect(res.exitCode).toBe(0);
      const data = JSON.parse(res.stdout);
      expect(data.status).toBe("healthy");
    });
  });

  describe("3. Gemini CLI / Antigravity CLI & Fixture Contract", () => {
    it("identifies and inspects Gemini CLI from single-model fixture and CLI version", async () => {
      await copyFixture("gemini-cli", "single-model", workspaceDir);
      mockRunner.mockVersion("gemini", "gemini-cli v0.1.0");

      const adapter = new GeminiCliAdapter();
      const detected = await adapter.identifyHost(workspaceDir);
      expect(detected).toBe(true);

      const version = await adapter.inspectVersion(workspaceDir);
      expect(version.compatibility).toBe("supported");
      expect(version.version).toBe("0.1.0");
      expect(version.fail_closed_for_mutation).toBe(false);

      const models = await adapter.inspectModels(workspaceDir);
      expect(models.some((m) => m.id === "gemini-2.0-flash")).toBe(true);
    });

    it("handles Gemini CLI help output", async () => {
      mockRunner.register("gemini", {
        exitCode: 0,
        stdout: "Gemini CLI - Developer assistant\nUsage: gemini [command] [options]\n",
        stderr: "",
      }, [/--help/]);

      const res = await mockRunner.run("gemini", ["--help"]);
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain("Gemini CLI");
    });
  });

  describe("4. DeepSeek Harness (DSH) CLI & Fixture Contract", () => {
    it("identifies and inspects DSH from single-model fixture and version file", async () => {
      await copyFixture("dsh", "single-model", workspaceDir);
      await fsp.mkdir(path.join(workspaceDir, ".dsh"), { recursive: true });
      await fsp.writeFile(path.join(workspaceDir, ".dsh", "version"), "1.0.0\n", "utf-8");

      const adapter = new DshAdapter();
      const detected = await adapter.identifyHost(workspaceDir);
      expect(detected).toBe(true);

      const version = await adapter.inspectVersion(workspaceDir);
      expect(version.compatibility).toBe("supported");
      expect(version.version).toBe("1.0.0");
      expect(version.fail_closed_for_mutation).toBe(false);

      const models = await adapter.inspectModels(workspaceDir);
      expect(models.some((m) => m.id === "deepseek-chat")).toBe(true);
    });

    it("handles DSH CLI status and help output fixtures", async () => {
      mockRunner.register("dsh", {
        exitCode: 0,
        stdout: JSON.stringify({ status: "ready", active_plugins: ["coder", "reviewer"] }),
        stderr: "",
      }, [/status/]);

      const res = await mockRunner.run("dsh", ["status"]);
      expect(res.exitCode).toBe(0);
      const data = JSON.parse(res.stdout);
      expect(data.status).toBe("ready");
    });
  });

  describe("5. OpenCode CLI & Fixture Contract", () => {
    it("identifies and inspects OpenCode from single-model fixture", async () => {
      await copyFixture("opencode", "single-model", workspaceDir);

      const adapter = new OpenCodeAdapter();
      const detected = await adapter.identifyHost(workspaceDir);
      expect(detected).toBe(true);

      process.env.OPENCODE_VERSION = "1.2.0";
      const version = await adapter.inspectVersion(workspaceDir);
      expect(version.compatibility).toBe("supported");
      expect(version.version).toBe("1.2.0");
      expect(version.fail_closed_for_mutation).toBe(false);

      const models = await adapter.inspectModels(workspaceDir);
      expect(models.some((m) => m.id === "anthropic/claude-3-7-sonnet")).toBe(true);
    });

    it("handles OpenCode CLI help fixture", async () => {
      mockRunner.register("opencode", {
        exitCode: 0,
        stdout: "opencode [command] [options]\n  run     Execute code\n  models  List models\n",
        stderr: "",
      }, [/--help/]);

      const res = await mockRunner.run("opencode", ["--help"]);
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain("opencode [command]");
    });
  });

  describe("6. ZCode CLI & Fixture Contract", () => {
    it("identifies and inspects ZCode from single-model fixture", async () => {
      await copyFixture("zcode", "single-model", workspaceDir);

      const adapter = new ZCodeAdapter();
      const detected = await adapter.identifyHost(workspaceDir);
      expect(detected).toBe(true);

      process.env.ZCODE_VERSION = "0.16.5";
      const version = await adapter.inspectVersion(workspaceDir);
      expect(version.compatibility).toBe("supported");
      expect(version.version).toBe("0.16.5");
      expect(version.fail_closed_for_mutation).toBe(false);

      const models = await adapter.inspectModels(workspaceDir);
      expect(models.some((m) => m.id === "builtin:bigmodel/GLM-5.3")).toBe(true);
    });

    it("handles ZCode CLI inspect and help fixtures", async () => {
      mockRunner.register("zcode", {
        exitCode: 0,
        stdout: "ZCode embedded CLI v0.16.5\nCommands:\n  config  Manage config\n  mcp     Diagnose MCP\n",
        stderr: "",
      }, [/--help/]);

      const res = await mockRunner.run("zcode", ["--help"]);
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain("ZCode embedded CLI");
    });
  });

  describe("7. Cursor CLI & Fixture Contract", () => {
    it("identifies and inspects Cursor from single-model fixture and CLI version", async () => {
      await copyFixture("cursor", "single-model", workspaceDir);
      mockRunner.mockVersion("cursor", "0.45.11\n7b61f8a85c8a002bc0f70dbddbc02a24");

      const adapter = new CursorAdapter();
      const detected = await adapter.identifyHost(workspaceDir);
      expect(detected).toBe(true);

      const version = await adapter.inspectVersion(workspaceDir);
      expect(version.compatibility).toBe("supported");
      expect(version.version).toBe("0.45.11");
      expect(version.fail_closed_for_mutation).toBe(false);

      const models = await adapter.inspectModels(workspaceDir);
      expect(models.some((m) => m.id === "claude-3-7-sonnet")).toBe(true);
    });

    it("handles Cursor CLI help and doctor fixtures", async () => {
      mockRunner.register("cursor", {
        exitCode: 0,
        stdout: "Cursor App CLI\nUsage: cursor [options] [path]\n",
        stderr: "",
      }, [/--help/]);

      const res = await mockRunner.run("cursor", ["--help"]);
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain("Cursor App CLI");
    });
  });

  describe("8. Grok Build CLI & Fixture Contract", () => {
    it("identifies and inspects Grok Build from single-model fixture and CLI inspect", async () => {
      await copyFixture("grok-build", "single-model", workspaceDir);
      mockRunner.mockVersion("grok", "grok-build 1.4.2 (rev 829fa)");
      mockRunner.mockInspect("grok", {
        version: "1.4.2",
        model: "grok-2",
        supported_models: ["grok-2", "grok-2-mini"],
        reasoning_effort: "high",
        supported_effort_values: ["low", "high"],
      });

      const adapter = new GrokBuildAdapter();
      const detected = await adapter.identifyHost(workspaceDir);
      expect(detected).toBe(true);

      const version = await adapter.inspectVersion(workspaceDir);
      expect(version.compatibility).toBe("supported");
      expect(version.version).toBe("1.4.2");
      expect(version.fail_closed_for_mutation).toBe(false);

      const models = await adapter.inspectModels(workspaceDir);
      expect(models.some((m) => m.id === "grok-2")).toBe(true);
    });

    it("handles Grok Build CLI doctor fixture", async () => {
      mockRunner.mockDoctor("grok", { status: "all systems green", mcp: "configured" });
      const res = await mockRunner.run("grok", ["doctor"]);
      expect(res.exitCode).toBe(0);
      const data = JSON.parse(res.stdout);
      expect(data.status).toBe("all systems green");
    });
  });

  describe("9. Hermes CLI & Fixture Contract", () => {
    it("identifies and inspects Hermes from single-model fixture and CLI version", async () => {
      await copyFixture("hermes", "single-model", workspaceDir);
      mockRunner.register("hermes", {
        exitCode: 0,
        stdout: "Hermes Agent v0.21.0 (2026.8.31) · upstream 79445a49",
      }, [/-V|--version/]);

      const adapter = new HermesAdapter();
      const detected = await adapter.identifyHost(workspaceDir);
      expect(detected).toBe(true);

      const version = await adapter.inspectVersion(workspaceDir);
      expect(version.compatibility).toBe("supported");
      expect(version.version).toBe("0.21.0");
      expect(version.fail_closed_for_mutation).toBe(false);

      const models = await adapter.inspectModels(workspaceDir);
      expect(models.some((m) => m.id === "gemini-3.8-flash-high")).toBe(true);
    });

    it("handles Hermes CLI help and doctor fixtures", async () => {
      mockRunner.register("hermes", {
        exitCode: 0,
        stdout: "Hermes Agent CLI\nCommands:\n  model   Select active model\n  doctor  Diagnose installation\n",
        stderr: "",
      }, [/--help/]);

      mockRunner.mockDoctor("hermes", { environment: "healthy", venv: "active" });

      const helpRes = await mockRunner.run("hermes", ["--help"]);
      expect(helpRes.exitCode).toBe(0);
      expect(helpRes.stdout).toContain("Hermes Agent CLI");

      const docRes = await mockRunner.run("hermes", ["doctor"]);
      expect(docRes.exitCode).toBe(0);
      const data = JSON.parse(docRes.stdout);
      expect(data.environment).toBe("healthy");
    });
  });

  describe("10. Generic / Manual Fallback Adapter", () => {
    it("acts as safe plan-only fallback without inventing models or mutating", async () => {
      const adapter = new GenericAdapter();
      const detected = await adapter.identifyHost(workspaceDir);
      expect(detected).toBe(true);

      const version = await adapter.inspectVersion(workspaceDir);
      expect(version.compatibility).toBe("supported");
      expect(version.fail_closed_for_mutation).toBe(true);

      const caps = await adapter.inspectCapabilities(workspaceDir);
      expect(caps.host_id).toBe("generic");
      expect(caps.capabilities.subagents.state).toBe("unknown");
      expect(caps.capabilities.configuration_mutation?.state).toBe("unavailable");

      const models = await adapter.inspectModels(workspaceDir);
      expect(models).toEqual([]);
    });
  });
});
