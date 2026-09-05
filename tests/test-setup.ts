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
delete process.env.OPENCODE_SESSION_ID;
delete process.env.CLAUDE_CODE;
delete process.env.CLAUDE_SESSION_ID;
delete process.env.CURSOR_SESSION_ID;
delete process.env.DSH_SESSION_ID;
delete process.env.GEMINI_CLI_SESSION_ID;
delete process.env.HERMES_SESSION_ID;
delete process.env.ZCODE_SESSION_ID;

import path from "node:path";
// Mask global agent-config binary from test PATH so tests asserting uninstalled/unreachable process states remain hermetic
if (process.env.PATH) {
  process.env.PATH = process.env.PATH.split(path.delimiter)
    .filter((dir) => !dir.includes(".local/bin") && !dir.includes(".npm-global"))
    .join(path.delimiter);
}
