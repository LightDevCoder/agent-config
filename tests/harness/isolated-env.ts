import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";

/**
 * Real user paths that must NEVER be read or mutated by tests (§78).
 */
export const PROTECTED_USER_PATHS = [
  ".codex",
  ".claude",
  ".claude.json",
  ".cursor",
  path.join(".config", "opencode"),
  ".grok",
  ".kiro",
  path.join(".config", "kiro"),
  path.join(".config", "zed"),
  ".copilot",
  path.join(".config", "github-copilot"),
  ".gemini",
  path.join(".config", "gemini"),
  ".dsh",
  path.join(".config", "dsh"),
  ".pi",
  path.join(".config", "pi"),
];

/**
 * Environment variables that can inadvertently point to real host installations.
 */
export const HOST_ENV_VARS_TO_CLEAN = [
  "CODEX_HOME",
  "CODEX_VERSION",
  "CODEX_THREAD_ID",
  "CODEX_SESSION_ID",
  "CODEX_WORKSPACE",
  "OPENCODE_CONFIG_DIR",
  "OPENCODE_CONFIG",
  "OPENCODE_SESSION_ID",
  "OPENCODE",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_HOME",
  "COPILOT_HOME",
  "COPILOT_CONFIG_DIR",
  "GEMINI_HOME",
  "GEMINI_CLI_HOME",
  "CURSOR_CONFIG_DIR",
  "KIRO_HOME",
  "KIRO_CONFIG_DIR",
  "ZED_HOME",
  "ZED_CONFIG_DIR",
  "DSH_HOME",
  "DSH_CONFIG_DIR",
  "GROK_HOME",
  "GROK_CONFIG_DIR",
  "GROK_BUILD",
  "GROK_SESSION",
  "GROK_SESSION_ID",
  "GROK_PROJECT_DIR",
  "GROK_VERSION",
  "GROK_POLICY_FILE",
  "GROK_MANAGED_CONFIG",
  "GROK_SUBAGENTS",
  "GROK_MAX_CONCURRENCY",
  "GROK_PARALLELISM",
  "GROK_WORKTREE_ISOLATION",
  "PI_CODING_AGENT",
  "PI_CODING_AGENT_DIR",
  "PI_SESSION_FILE",
  "PI_SESSION_ID",
  "PI_MODEL",
  "PI_PROVIDER",
  "PI_REASONING_LEVEL",
  "PI_VERSION",
  "AI_AGENT",
];

export interface IsolatedEnvOptions {
  baseDir?: string;
  env?: Record<string, string | undefined>;
  cleanHostEnv?: boolean;
  protectRealHome?: boolean;
}

export interface PathSnapshot {
  path: string;
  exists: boolean;
  mtimeMs?: number;
  size?: number;
}

export interface DirectoryFileSnapshot {
  relativePath: string;
  size: number;
  mtimeMs: number;
}

/**
 * Isolated sandboxed environment for test execution (§78).
 * Guarantees custom HOME, XDG_CONFIG_HOME, and workspace directories,
 * while preventing accidental interaction with real user configurations.
 */
export class IsolatedEnv {
  readonly tempDir: string;
  readonly homeDir: string;
  readonly xdgConfigHome: string;
  readonly workspaceDir: string;

  private originalEnv: NodeJS.ProcessEnv;
  private originalHomedir: () => string;
  private realHome: string;
  private protectedSnapshots: Map<string, PathSnapshot> = new Map();
  private isActive = false;
  private options: IsolatedEnvOptions;

  constructor(options: IsolatedEnvOptions = {}) {
    this.options = options;
    const base = options.baseDir || os.tmpdir();
    this.tempDir = fs.mkdtempSync(path.join(base, "agent-config-sandbox-"));
    this.homeDir = path.join(this.tempDir, "home");
    this.xdgConfigHome = path.join(this.homeDir, ".config");
    this.workspaceDir = path.join(this.tempDir, "workspace");

    fs.mkdirSync(this.homeDir, { recursive: true });
    fs.mkdirSync(this.xdgConfigHome, { recursive: true });
    fs.mkdirSync(this.workspaceDir, { recursive: true });

    this.originalEnv = { ...process.env };
    this.originalHomedir = os.homedir.bind(os);
    this.realHome = this.originalHomedir();
  }

  /**
   * Activates sandbox by redirecting environment variables and os.homedir().
   */
  activate(): void {
    if (this.isActive) return;

    // Snapshot protected paths in real user home
    this.snapshotProtectedPaths();

    // Clean host-specific env vars if requested (default true)
    if (this.options.cleanHostEnv !== false) {
      for (const varName of HOST_ENV_VARS_TO_CLEAN) {
        delete process.env[varName];
      }
    }

    // Set sandbox directories
    process.env.HOME = this.homeDir;
    process.env.USERPROFILE = this.homeDir;
    process.env.XDG_CONFIG_HOME = this.xdgConfigHome;

    // Apply custom env overrides
    if (this.options.env) {
      for (const [key, value] of Object.entries(this.options.env)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }

    // Redirect os.homedir() to sandbox homeDir
    const sandboxHome = this.homeDir;
    os.homedir = () => sandboxHome;

    this.isActive = true;
  }

  /**
   * Restores original environment and verifies no real user configs were modified.
   */
  restore(): void {
    if (!this.isActive) return;

    // Assert real user directories were not created or modified
    if (this.options.protectRealHome !== false) {
      this.assertNoRealUserDirTouched();
    }

    // Restore environment variables
    for (const key of Object.keys(process.env)) {
      if (!(key in this.originalEnv)) {
        delete process.env[key];
      }
    }
    for (const [key, value] of Object.entries(this.originalEnv)) {
      if (value !== undefined) {
        process.env[key] = value;
      }
    }

    // Restore os.homedir
    os.homedir = this.originalHomedir;

    this.isActive = false;
  }

  /**
   * Verifies that protected real user directories were untouched.
   */
  assertNoRealUserDirTouched(): void {
    for (const [relPath, snapshot] of this.protectedSnapshots.entries()) {
      const fullPath = path.join(this.realHome, relPath);
      const currentlyExists = fs.existsSync(fullPath);

      if (!snapshot.exists && currentlyExists) {
        throw new Error(
          `[SAFETY VIOLATION] Real user directory/file was created during test execution: ${fullPath}`
        );
      }

      if (snapshot.exists && currentlyExists) {
        try {
          const stat = fs.statSync(fullPath);
          if (stat.mtimeMs !== snapshot.mtimeMs) {
            throw new Error(
              `[SAFETY VIOLATION] Real user directory/file was modified during test execution: ${fullPath}`
            );
          }
        } catch (err: unknown) {
          // If deleted or inaccessible, fail
          if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            throw new Error(
              `[SAFETY VIOLATION] Real user directory/file was deleted during test execution: ${fullPath}`
            );
          }
        }
      }
    }
  }

  /**
   * Cleans up the temporary sandbox directory and restores state.
   */
  async cleanup(): Promise<void> {
    this.restore();
    if (fs.existsSync(this.tempDir)) {
      await fsp.rm(this.tempDir, { recursive: true, force: true });
    }
  }

  /**
   * Takes a snapshot of all files in a directory to detect silent mutations.
   */
  snapshotDirectory(targetDir: string): Map<string, DirectoryFileSnapshot> {
    const results = new Map<string, DirectoryFileSnapshot>();
    if (!fs.existsSync(targetDir)) {
      return results;
    }

    const walk = (currentDir: string) => {
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile()) {
          const stat = fs.statSync(full);
          const rel = path.relative(targetDir, full);
          results.set(rel, {
            relativePath: rel,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
          });
        }
      }
    };

    walk(targetDir);
    return results;
  }

  /**
   * Asserts that a directory's contents have not been modified since the snapshot.
   */
  assertDirectoryUnchanged(
    targetDir: string,
    before: Map<string, DirectoryFileSnapshot>,
    operationName = "Operation"
  ): void {
    const after = this.snapshotDirectory(targetDir);

    // Check for added files
    for (const [rel, snapshot] of after.entries()) {
      if (!before.has(rel)) {
        throw new Error(
          `[SILENT MUTATION VIOLATION] ${operationName} created unexpected file: ${rel} in ${targetDir}`
        );
      }
      const beforeSnapshot = before.get(rel)!;
      if (beforeSnapshot.size !== snapshot.size) {
        throw new Error(
          `[SILENT MUTATION VIOLATION] ${operationName} altered file size of: ${rel} (${beforeSnapshot.size} -> ${snapshot.size}) in ${targetDir}`
        );
      }
    }

    // Check for deleted files
    for (const rel of before.keys()) {
      if (!after.has(rel)) {
        throw new Error(
          `[SILENT MUTATION VIOLATION] ${operationName} deleted file: ${rel} in ${targetDir}`
        );
      }
    }
  }

  private snapshotProtectedPaths(): void {
    this.protectedSnapshots.clear();
    for (const relPath of PROTECTED_USER_PATHS) {
      const fullPath = path.join(this.realHome, relPath);
      try {
        if (fs.existsSync(fullPath)) {
          const stat = fs.statSync(fullPath);
          this.protectedSnapshots.set(relPath, {
            path: fullPath,
            exists: true,
            mtimeMs: stat.mtimeMs,
            size: stat.size,
          });
        } else {
          this.protectedSnapshots.set(relPath, {
            path: fullPath,
            exists: false,
          });
        }
      } catch {
        this.protectedSnapshots.set(relPath, {
          path: fullPath,
          exists: false,
        });
      }
    }
  }
}

/**
 * Creates an isolated sandbox environment.
 */
export function createIsolatedEnv(options?: IsolatedEnvOptions): IsolatedEnv {
  return new IsolatedEnv(options);
}

/**
 * Executes an async test block inside an isolated sandbox, automatically cleaning up.
 */
export async function runInIsolatedEnv<T>(
  fn: (env: IsolatedEnv) => Promise<T>,
  options?: IsolatedEnvOptions
): Promise<T> {
  const env = createIsolatedEnv(options);
  env.activate();
  try {
    return await fn(env);
  } finally {
    await env.cleanup();
  }
}

/**
 * Copies a test fixture from `tests/fixtures/<harness>/<scenario>` into target directory.
 */
export async function copyFixture(
  harness: string,
  scenario: string,
  targetDir: string
): Promise<string> {
  // Find project fixtures dir relative to this file
  const fixtureDir = path.resolve(__dirname, "..", "fixtures", harness, scenario);
  if (!fs.existsSync(fixtureDir)) {
    throw new Error(`Fixture not found: ${fixtureDir}`);
  }

  await fsp.mkdir(targetDir, { recursive: true });
  await copyRecursive(fixtureDir, targetDir);
  return targetDir;
}

async function copyRecursive(src: string, dest: string): Promise<void> {
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await fsp.mkdir(destPath, { recursive: true });
      await copyRecursive(srcPath, destPath);
    } else {
      await fsp.mkdir(path.dirname(destPath), { recursive: true });
      await fsp.copyFile(srcPath, destPath);
    }
  }
}
