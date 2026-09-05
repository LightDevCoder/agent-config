import { describe, it, expect, beforeEach, afterEach } from "vitest";
import childProcess from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  IsolatedEnv,
  createIsolatedEnv,
  runInIsolatedEnv,
  PROTECTED_USER_PATHS,
} from "./harness/isolated-env.js";
import { MockSubprocessRunner, createMockSubprocessRunner } from "./harness/mock-runner.js";

describe("Test Harness: Isolated Environment & Protected User Paths (§78)", () => {
  it("isolates HOME, XDG_CONFIG_HOME, and os.homedir() into temporary directory", async () => {
    const originalHome = os.homedir();
    const env = createIsolatedEnv();

    try {
      env.activate();

      expect(os.homedir()).toBe(env.homeDir);
      expect(process.env.HOME).toBe(env.homeDir);
      expect(process.env.USERPROFILE).toBe(env.homeDir);
      expect(process.env.XDG_CONFIG_HOME).toBe(env.xdgConfigHome);
      expect(env.homeDir).not.toBe(originalHome);
      expect(fs.existsSync(env.homeDir)).toBe(true);
      expect(fs.existsSync(env.workspaceDir)).toBe(true);
    } finally {
      await env.cleanup();
      expect(os.homedir()).toBe(originalHome);
    }
  });

  it("scrubs host-specific environment variables in isolated sandbox", async () => {
    process.env.CODEX_HOME = "/should/be/cleared";
    process.env.OPENCODE_CONFIG_DIR = "/should/be/cleared";
    process.env.CLAUDE_CONFIG_DIR = "/should/be/cleared";
    process.env.GEMINI_HOME = "/should/be/cleared";

    await runInIsolatedEnv(async (env) => {
      expect(process.env.CODEX_HOME).toBeUndefined();
      expect(process.env.OPENCODE_CONFIG_DIR).toBeUndefined();
      expect(process.env.CLAUDE_CONFIG_DIR).toBeUndefined();
      expect(process.env.GEMINI_HOME).toBeUndefined();
    });

    // Clean up test leftovers
    delete process.env.CODEX_HOME;
    delete process.env.OPENCODE_CONFIG_DIR;
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.GEMINI_HOME;
  });

  it("detects silent file additions, modifications, and deletions with snapshotDirectory", async () => {
    const env = createIsolatedEnv();
    env.activate();

    try {
      const testDir = path.join(env.workspaceDir, "test-target");
      await fsp.mkdir(testDir, { recursive: true });
      await fsp.writeFile(path.join(testDir, "file1.txt"), "hello", "utf-8");

      const snapshot = env.snapshotDirectory(testDir);
      expect(snapshot.has("file1.txt")).toBe(true);

      // No mutation check passes
      expect(() => env.assertDirectoryUnchanged(testDir, snapshot, "NoOp")).not.toThrow();

      // Mutation: file addition
      await fsp.writeFile(path.join(testDir, "added.txt"), "new", "utf-8");
      expect(() => env.assertDirectoryUnchanged(testDir, snapshot, "Addition")).toThrow(
        /unexpected file/
      );
      await fsp.rm(path.join(testDir, "added.txt"));

      // Mutation: file change
      await fsp.writeFile(path.join(testDir, "file1.txt"), "hello modified world", "utf-8");
      expect(() => env.assertDirectoryUnchanged(testDir, snapshot, "Modify")).toThrow(
        /altered file size/
      );

      // Mutation: file deletion
      await fsp.rm(path.join(testDir, "file1.txt"));
      expect(() => env.assertDirectoryUnchanged(testDir, snapshot, "Delete")).toThrow(
        /deleted file/
      );
    } finally {
      await env.cleanup();
    }
  });

  it("lists all mandatory protected real user paths (§78)", () => {
    expect(PROTECTED_USER_PATHS).toContain(".codex");
    expect(PROTECTED_USER_PATHS).toContain(".claude");
    expect(PROTECTED_USER_PATHS).toContain(".cursor");
    expect(PROTECTED_USER_PATHS).toContain(path.join(".config", "opencode"));
    expect(PROTECTED_USER_PATHS).toContain(".grok");
    expect(PROTECTED_USER_PATHS).toContain(".kiro");
    expect(PROTECTED_USER_PATHS).toContain(path.join(".config", "zed"));
    expect(PROTECTED_USER_PATHS).toContain(".copilot");
    expect(PROTECTED_USER_PATHS).toContain(".gemini");
    expect(PROTECTED_USER_PATHS).toContain(".dsh");
  });
});

describe("Test Harness: Mock CLI Subprocess Runner (§79)", () => {
  let runner: MockSubprocessRunner;

  beforeEach(() => {
    runner = createMockSubprocessRunner();
  });

  afterEach(() => {
    runner.uninstallGlobalHook();
    runner.reset();
  });

  it("registers and executes mock commands with exact stdout and exit status", async () => {
    runner.register("my-cli", {
      exitCode: 0,
      stdout: "hello stdout",
      stderr: "",
    });

    const res = await runner.run("my-cli", ["status"]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("hello stdout");
    expect(runner.getExecutedCommands()).toHaveLength(1);
    expect(runner.getExecutedCommands()[0].command).toBe("my-cli");
  });

  it("mocks JSON inspect and mcp list outputs seamlessly", async () => {
    runner.mockInspect("tool-cli", {
      version: "2.1.0",
      models: ["model-a", "model-b"],
    });

    runner.mockMcpList("tool-cli", {
      servers: {
        "agent-config": { command: "agent-config" },
      },
    });

    const inspectRes = await runner.run("tool-cli", ["inspect", "--json"]);
    expect(inspectRes.exitCode).toBe(0);
    const parsedInspect = JSON.parse(inspectRes.stdout);
    expect(parsedInspect.version).toBe("2.1.0");

    const mcpRes = await runner.run("tool-cli", ["mcp", "list"]);
    expect(mcpRes.exitCode).toBe(0);
    const parsedMcp = JSON.parse(mcpRes.stdout);
    expect(parsedMcp.servers["agent-config"]).toBeDefined();
  });

  it("fails closed on unmocked commands to prevent real command execution", async () => {
    await expect(runner.run("unregistered-dangerous-binary", ["--rm", "-rf"])).rejects.toThrow(
      /Unmocked CLI command execution prevented/
    );
  });

  it("intercepts global child_process calls when global hook is installed", async () => {
    runner.mockJson("claude", { status: "ready" }, [/doctor/]);
    runner.mockFailure("git", 1, "fatal: not a git repo", [/status/]);
    runner.installGlobalHook();

    // Test execFile
    const execFilePromise = new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      childProcess.execFile("claude", ["doctor"], (err, stdout, stderr) => {
        if (err) reject(err);
        else resolve({ stdout, stderr });
      });
    });

    const execFileRes = await execFilePromise;
    expect(JSON.parse(execFileRes.stdout).status).toBe("ready");

    // Test execSync
    expect(() => childProcess.execSync("git status")).toThrow(/Command failed/);

    // Assert commands recorded
    runner.assertCalled("claude", 1, [/doctor/]);
    runner.assertCalled("git", 1, [/status/]);
  });
});
