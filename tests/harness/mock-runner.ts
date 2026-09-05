import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

export interface SubprocessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ExecutedCommand {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  timestamp: number;
}

export interface MockCommandResponse {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  error?: Error;
}

export type MockCommandHandler = (
  command: string,
  args: string[],
  options?: { cwd?: string; env?: Record<string, string> }
) => MockCommandResponse | Promise<MockCommandResponse>;

export interface MockRule {
  commandPattern: string | RegExp;
  argsPattern?: Array<string | RegExp>;
  responseOrHandler: MockCommandResponse | MockCommandHandler;
  once?: boolean;
}

/**
 * Mock runner and registry for CLI subprocess execution (§79).
 * Allows mocking machine-readable CLI commands (`inspect --json`, `mcp list`, `doctor`, exit codes)
 * and intercepts node:child_process to prevent uncontrolled execution.
 */
export class MockSubprocessRunner {
  private rules: MockRule[] = [];
  private executed: ExecutedCommand[] = [];
  private isHooked = false;

  private originalExecFile?: typeof childProcess.execFile;
  private originalExec?: typeof childProcess.exec;
  private originalSpawn?: typeof childProcess.spawn;
  private originalExecSync?: typeof childProcess.execSync;
  private originalExecFileSync?: typeof childProcess.execFileSync;

  /**
   * Registers a mock response for a command matching pattern and optional args.
   */
  register(
    commandPattern: string | RegExp,
    responseOrHandler: MockCommandResponse | MockCommandHandler,
    argsPattern?: Array<string | RegExp>,
    once = false
  ): this {
    this.rules.push({
      commandPattern,
      argsPattern,
      responseOrHandler,
      once,
    });
    return this;
  }

  /**
   * Registers a one-time mock response.
   */
  registerOnce(
    commandPattern: string | RegExp,
    responseOrHandler: MockCommandResponse | MockCommandHandler,
    argsPattern?: Array<string | RegExp>
  ): this {
    return this.register(commandPattern, responseOrHandler, argsPattern, true);
  }

  /**
   * Convenience helper to mock JSON output from a CLI command.
   */
  mockJson(
    command: string | RegExp,
    jsonPayload: unknown,
    argsPattern?: Array<string | RegExp>,
    exitCode = 0
  ): this {
    return this.register(
      command,
      {
        exitCode,
        stdout: typeof jsonPayload === "string" ? jsonPayload : JSON.stringify(jsonPayload, null, 2),
        stderr: "",
      },
      argsPattern
    );
  }

  /**
   * Convenience helper to mock command failure with exit code and stderr.
   */
  mockFailure(
    command: string | RegExp,
    exitCode = 1,
    stderr = "Command failed",
    argsPattern?: Array<string | RegExp>
  ): this {
    return this.register(
      command,
      {
        exitCode,
        stdout: "",
        stderr,
      },
      argsPattern
    );
  }

  /**
   * Mock CLI `inspect --json` output.
   */
  mockInspect(command: string | RegExp, inspectData: unknown): this {
    return this.mockJson(command, inspectData, [/inspect/, /--json/]);
  }

  /**
   * Mock CLI `mcp list` output.
   */
  mockMcpList(command: string | RegExp, mcpData: unknown): this {
    return this.mockJson(command, mcpData, [/mcp/, /list/]);
  }

  /**
   * Mock CLI `doctor` or `status` output.
   */
  mockDoctor(command: string | RegExp, doctorData: unknown): this {
    return this.mockJson(command, doctorData, [/doctor|status/]);
  }

  /**
   * Mock CLI `--version` output.
   */
  mockVersion(command: string | RegExp, versionString: string): this {
    return this.register(
      command,
      {
        exitCode: 0,
        stdout: versionString.trim() + "\n",
        stderr: "",
      },
      [/--version|-v|version/]
    );
  }

  /**
   * Directly executes a command against registered mocks.
   */
  async run(
    command: string,
    args: string[] = [],
    options?: { cwd?: string; env?: Record<string, string> }
  ): Promise<SubprocessResult> {
    const matched = await this.findAndEvaluateRule(command, args, options);
    this.recordExecution(command, args, options);

    if (matched.error) {
      throw matched.error;
    }

    return {
      exitCode: matched.exitCode ?? 0,
      stdout: matched.stdout ?? "",
      stderr: matched.stderr ?? "",
    };
  }

  /**
   * Synchronously executes a command against registered mocks.
   */
  runSync(
    command: string,
    args: string[] = [],
    options?: { cwd?: string; env?: Record<string, string> }
  ): SubprocessResult {
    const matched = this.findAndEvaluateRuleSync(command, args, options);
    this.recordExecution(command, args, options);

    if (matched.error) {
      throw matched.error;
    }

    return {
      exitCode: matched.exitCode ?? 0,
      stdout: matched.stdout ?? "",
      stderr: matched.stderr ?? "",
    };
  }

  /**
   * Returns all commands executed during the session.
   */
  getExecutedCommands(): ExecutedCommand[] {
    return [...this.executed];
  }

  /**
   * Asserts that a command was executed with given criteria.
   */
  assertCalled(
    commandPattern: string | RegExp,
    times?: number,
    argsPattern?: Array<string | RegExp>
  ): void {
    const matches = this.executed.filter((cmd) => {
      const cmdMatch =
        typeof commandPattern === "string"
          ? cmd.command === commandPattern || cmd.command.endsWith("/" + commandPattern)
          : commandPattern.test(cmd.command);

      if (!cmdMatch) return false;
      if (!argsPattern) return true;

      if (argsPattern.length !== cmd.args.length) return false;
      return argsPattern.every((pat, idx) => {
        const actualArg = cmd.args[idx] || "";
        return typeof pat === "string" ? actualArg === pat : pat.test(actualArg);
      });
    });

    if (times !== undefined) {
      if (matches.length !== times) {
        throw new Error(
          `Expected command ${commandPattern} to be called ${times} time(s), but was called ${matches.length} time(s).`
        );
      }
    } else if (matches.length === 0) {
      throw new Error(`Expected command ${commandPattern} to have been called at least once.`);
    }
  }

  /**
   * Clears execution history.
   */
  clearHistory(): void {
    this.executed = [];
  }

  /**
   * Resets both rules and execution history.
   */
  reset(): void {
    this.rules = [];
    this.executed = [];
  }

  /**
   * Installs global monkey-patches on node:child_process to intercept executions.
   */
  installGlobalHook(): void {
    if (this.isHooked) return;

    this.originalExecFile = childProcess.execFile;
    this.originalExec = childProcess.exec;
    this.originalSpawn = childProcess.spawn;
    this.originalExecSync = childProcess.execSync;
    this.originalExecFileSync = childProcess.execFileSync;

    const self = this;

    // Hook childProcess.execFile
    (childProcess as any).execFile = function (file: string, ...rest: any[]) {
      let args: string[] = [];
      let options: any = {};
      let callback: ((error: Error | null, stdout: string, stderr: string) => void) | undefined;

      if (Array.isArray(rest[0])) {
        args = rest[0];
        if (typeof rest[1] === "function") {
          callback = rest[1];
        } else if (typeof rest[1] === "object") {
          options = rest[1];
          callback = rest[2];
        }
      } else if (typeof rest[0] === "function") {
        callback = rest[0];
      } else if (typeof rest[0] === "object") {
        options = rest[0];
        callback = rest[1];
      }

      self
        .run(file, args, options)
        .then((res) => {
          if (res.exitCode !== 0) {
            const err = new Error(`Command failed with exit code ${res.exitCode}: ${file}`) as any;
            err.code = res.exitCode;
            err.stdout = res.stdout;
            err.stderr = res.stderr;
            callback?.(err, res.stdout, res.stderr);
          } else {
            callback?.(null, res.stdout, res.stderr);
          }
        })
        .catch((err) => {
          callback?.(err, "", err.message || "");
        });

      return createMockChildProcess();
    };

    // Hook childProcess.exec
    (childProcess as any).exec = function (commandLine: string, ...rest: any[]) {
      let options: any = {};
      let callback: ((error: Error | null, stdout: string, stderr: string) => void) | undefined;

      if (typeof rest[0] === "function") {
        callback = rest[0];
      } else if (typeof rest[0] === "object") {
        options = rest[0];
        callback = rest[1];
      }

      const parts = commandLine.trim().split(/\s+/);
      const file = parts[0] || "";
      const args = parts.slice(1);

      self
        .run(file, args, options)
        .then((res) => {
          if (res.exitCode !== 0) {
            const err = new Error(`Command failed with exit code ${res.exitCode}: ${commandLine}`) as any;
            err.code = res.exitCode;
            err.stdout = res.stdout;
            err.stderr = res.stderr;
            callback?.(err, res.stdout, res.stderr);
          } else {
            callback?.(null, res.stdout, res.stderr);
          }
        })
        .catch((err) => {
          callback?.(err, "", err.message || "");
        });

      return createMockChildProcess();
    };

    // Hook childProcess.spawn
    (childProcess as any).spawn = function (file: string, args: string[] = [], options: any = {}) {
      const cp = createMockChildProcess();
      self
        .run(file, args, options)
        .then((res) => {
          if (res.stdout) {
            (cp.stdout as Readable).push(Buffer.from(res.stdout));
          }
          (cp.stdout as Readable).push(null);

          if (res.stderr) {
            (cp.stderr as Readable).push(Buffer.from(res.stderr));
          }
          (cp.stderr as Readable).push(null);

          cp.emit("close", res.exitCode);
          cp.emit("exit", res.exitCode);
        })
        .catch((err) => {
          cp.emit("error", err);
        });

      return cp;
    };

    // Hook childProcess.execSync
    (childProcess as any).execSync = function (commandLine: string, options: any = {}) {
      const parts = commandLine.trim().split(/\s+/);
      const file = parts[0] || "";
      const args = parts.slice(1);
      const res = self.runSync(file, args, options);
      if (res.exitCode !== 0) {
        const err = new Error(`Command failed: ${commandLine}`) as any;
        err.status = res.exitCode;
        err.stdout = res.stdout;
        err.stderr = res.stderr;
        throw err;
      }
      return options.encoding === "utf-8" || options.encoding === "utf8"
        ? res.stdout
        : Buffer.from(res.stdout);
    };

    // Hook childProcess.execFileSync
    (childProcess as any).execFileSync = function (file: string, args: string[] = [], options: any = {}) {
      const res = self.runSync(file, args, options);
      if (res.exitCode !== 0) {
        const err = new Error(`Command failed: ${file}`) as any;
        err.status = res.exitCode;
        err.stdout = res.stdout;
        err.stderr = res.stderr;
        throw err;
      }
      return options.encoding === "utf-8" || options.encoding === "utf8"
        ? res.stdout
        : Buffer.from(res.stdout);
    };

    this.isHooked = true;
  }

  /**
   * Restores original node:child_process functions.
   */
  uninstallGlobalHook(): void {
    if (!this.isHooked) return;

    if (this.originalExecFile) (childProcess as any).execFile = this.originalExecFile;
    if (this.originalExec) (childProcess as any).exec = this.originalExec;
    if (this.originalSpawn) (childProcess as any).spawn = this.originalSpawn;
    if (this.originalExecSync) (childProcess as any).execSync = this.originalExecSync;
    if (this.originalExecFileSync) (childProcess as any).execFileSync = this.originalExecFileSync;

    this.isHooked = false;
  }

  private async findAndEvaluateRule(
    command: string,
    args: string[],
    options?: { cwd?: string; env?: Record<string, string> }
  ): Promise<MockCommandResponse> {
    const matchIndex = this.rules.findIndex((r) => this.matchesRule(r, command, args));
    if (matchIndex === -1) {
      throw new Error(
        `[MockSubprocessRunner] Unmocked CLI command execution prevented: "${command} ${args.join(" ")}". Register a mock response to allow.`
      );
    }

    const rule = this.rules[matchIndex]!;
    if (rule.once) {
      this.rules.splice(matchIndex, 1);
    }

    if (typeof rule.responseOrHandler === "function") {
      return await rule.responseOrHandler(command, args, options);
    }
    return rule.responseOrHandler;
  }

  private findAndEvaluateRuleSync(
    command: string,
    args: string[],
    options?: { cwd?: string; env?: Record<string, string> }
  ): MockCommandResponse {
    const matchIndex = this.rules.findIndex((r) => this.matchesRule(r, command, args));
    if (matchIndex === -1) {
      throw new Error(
        `[MockSubprocessRunner] Unmocked CLI command execution prevented: "${command} ${args.join(" ")}". Register a mock response to allow.`
      );
    }

    const rule = this.rules[matchIndex]!;
    if (rule.once) {
      this.rules.splice(matchIndex, 1);
    }

    if (typeof rule.responseOrHandler === "function") {
      const res = rule.responseOrHandler(command, args, options);
      if (res instanceof Promise) {
        throw new Error("Synchronous execution cannot use async MockCommandHandler.");
      }
      return res;
    }
    return rule.responseOrHandler;
  }

  private matchesRule(rule: MockRule, command: string, args: string[]): boolean {
    const cmdMatch =
      typeof rule.commandPattern === "string"
        ? command === rule.commandPattern || command.endsWith("/" + rule.commandPattern)
        : rule.commandPattern.test(command);

    if (!cmdMatch) return false;
    if (!rule.argsPattern) return true;

    if (rule.argsPattern.length > args.length) return false;

    // Check if every pattern in argsPattern matches at least one arg in order or anywhere
    return rule.argsPattern.every((pat) =>
      args.some((arg) => (typeof pat === "string" ? arg === pat : pat.test(arg)))
    );
  }

  private recordExecution(
    command: string,
    args: string[],
    options?: { cwd?: string; env?: Record<string, string> }
  ): void {
    this.executed.push({
      command,
      args: [...args],
      cwd: options?.cwd,
      env: options?.env,
      timestamp: Date.now(),
    });
  }
}

function createMockChildProcess(): any {
  const emitter = new EventEmitter() as any;
  emitter.stdout = new Readable({ read() {} });
  emitter.stderr = new Readable({ read() {} });
  emitter.stdin = { write() {}, end() {} };
  emitter.kill = () => true;
  emitter.pid = 99999;
  return emitter;
}

export function createMockSubprocessRunner(): MockSubprocessRunner {
  return new MockSubprocessRunner();
}
