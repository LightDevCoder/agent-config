// Clear harness runtime environment variables that might leak into tests from the host process
delete process.env.GROK_BUILD;
delete process.env.GROK_HOME;
delete process.env.GROK_SESSION;
delete process.env.GROK_SESSION_ID;
delete process.env.GROK_PROJECT_DIR;
delete process.env.GROK_CONFIG_DIR;
delete process.env.GROK_VERSION;
delete process.env.GROK_AGENT;
delete process.env.CODEX_SESSION;
for (const name of ["CODEX_THREAD_ID", "CODEX_SESSION_ID", "CODEX_WORKSPACE", "CODEX_HOME",
  "CODEX_VERSION", "CODEX_SUBAGENTS", "CODEX_MAX_CONCURRENCY"]) {
  delete process.env[name];
}
delete process.env.OPENCODE_SESSION_ID;
delete process.env.CLAUDE_CODE;
delete process.env.CLAUDE_SESSION_ID;
delete process.env.CURSOR_SESSION_ID;
delete process.env.DSH_SESSION_ID;
delete process.env.GEMINI_CLI_SESSION_ID;
delete process.env.HERMES_SESSION_ID;
delete process.env.ZCODE_SESSION_ID;
delete process.env.PI_CODING_AGENT;
delete process.env.AI_AGENT;
delete process.env.PI_SESSION_FILE;
delete process.env.PI_SESSION_ID;
delete process.env.PI_MODEL;
delete process.env.PI_PROVIDER;
delete process.env.PI_REASONING_LEVEL;
delete process.env.PI_VERSION;
delete process.env.PI_CODING_AGENT_DIR;

import path from "node:path";
// Mask global agent-config binary from test PATH so tests asserting uninstalled/unreachable process states remain hermetic
if (process.env.PATH) {
  process.env.PATH = process.env.PATH.split(path.delimiter)
    .filter((dir) => !dir.includes(".local/bin") && !dir.includes(".npm-global"))
    .join(path.delimiter);
}
