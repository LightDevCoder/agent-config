# Cursor Adapter Evidence Record

## Adapter ID
- **Adapter ID:** `cursor`

## Product / Harness Identity
- **Product Name:** Cursor / Cursor Agent CLI
- **Harness ID:** `cursor`
- **Binary / Executable Names:**
  - Standalone Terminal Agent: `cursor-agent` (installed at `~/.local/bin/cursor-agent`)
  - Desktop Application CLI: `/Applications/Cursor.app/Contents/Resources/app/bin/cursor` (delegates `cursor agent` to `~/.local/bin/cursor-agent`, and `cursor editor` to Electron CLI)
  - Desktop Application: `/Applications/Cursor.app/Contents/MacOS/Cursor`
- **Runtime Environment Markers:**
  - `CURSOR_CLI` (`1` or `true`)
  - `CURSOR_AGENT` (`1` or `true`)
  - `CURSOR_CLI_COMPAT`
  - `CURSOR_SESSION_ID`
  - `CURSOR_PROJECT_DIR`
  - `CURSOR_CONFIG_DIR`
  - `CURSOR_API_KEY` / `CURSOR_AUTH_TOKEN`
  - `CURSOR_API_ENDPOINT`
  - Active process title or binary basename containing `cursor` or `cursor-agent`

## Version Checked & Date Checked
- **Version Checked:**
  - Cursor Agent CLI: `2026.09.02-c22c1a3` (`cursor-agent --version` / `cursor agent --version`)
  - Cursor IDE CLI: `3.18.25` (`cursor --version`)
- **Date Checked:** 2026-09-05

## Official Upstream, Documentation, & Config Schema Sources
- **Official Upstream:** Anysphere Cursor (`https://cursor.com`, `https://api2.cursor.sh`)
- **Official Documentation:**
  - Built-in Cursor Agent CLI help: `cursor-agent --help`, `cursor-agent mcp --help`, `cursor-agent about`
  - Built-in Cursor IDE CLI help: `cursor --help`, `cursor --add-mcp`
- **Official Config/Schema Source:**
  - Project Scope MCP: `<workspace>/.cursor/mcp.json`
  - User/Global Scope MCP: `~/.cursor/mcp.json`
  - Project Settings & Rules: `<workspace>/.cursor/settings.json`, `<workspace>/.cursorrules`
  - User Settings: `~/.cursor/settings.json`, `~/.config/Cursor/User/settings.json`
  - Worktrees: `<workspace>/.cursor/worktrees.json` or `~/.cursor/worktrees/<reponame>/<name>`

## Separation of Cursor Agent CLI vs IDE UI Features
- **Distinction from Real Host Inspection:**
  - **Cursor Agent CLI (`cursor-agent` / `cursor agent`):**
    - Directly runs terminal agent sessions with independent options: `--model <model>`, `--plan`, `--trust`, `--approve-mcps`, `--output-format text|json|stream-json`.
    - Manages MCP servers via native subcommands: `cursor-agent mcp list`, `cursor-agent mcp list-tools <id>`, `cursor-agent mcp enable <id>`, `cursor-agent mcp disable <id>`.
    - Manages isolated worktrees: `-w, --worktree [name]`, `--worktree-base <branch>`, `--skip-worktree-setup`.
    - Supports background worker execution: `cursor-agent worker` (Cloud Agent personal "My Machines" worker or team Self-Hosted Pool worker).
  - **Cursor IDE UI:**
    - Visual editor workbench features (Composer, multi-window UI, chat sidebar) are distinct from headless or terminal agent capabilities.
    - CLI commands like `cursor --add-mcp <json>` add MCP servers to the user profile or workspace (`--mcp-workspace`).
  - **Adapter Principle:** The adapter prioritizes native CLI and file-based inspection (`.cursor/mcp.json`, `settings.json`, `cursor-agent mcp list`) rather than assuming IDE UI behavior.

## Executable Detection & Version Detection
- **Executable Detection:**
  - Active process check: `CURSOR_CLI`, `CURSOR_AGENT`, `CURSOR_SESSION_ID`, `CURSOR_PROJECT_DIR`, `CURSOR_CONFIG_DIR`, or process title/path matching `cursor` or `cursor-agent`.
  - PATH lookup: `which cursor-agent`, `which cursor`, or known location `~/.local/bin/cursor-agent`.
  - Workspace markers: presence of `.cursor/` directory, `.cursor/settings.json`, `.cursor/mcp.json`, `.cursorrules`.
  - User markers: presence of `~/.cursor/`, `~/.cursor/mcp.json`, `~/.config/Cursor/`.
- **Version Detection:**
  - Environment variable: `CURSOR_VERSION`, `CURSOR_CLI_VERSION`.
  - CLI execution: `cursor-agent --version` or `cursor --version`.
  - File markers: `<workspace>/.cursor/version` or `~/.cursor/version`.
- **Compatibility Classification:**
  - CalVer (e.g. `2026.09.02-c22c1a3`) and SemVer (`0.x`, `1.x`, `3.x`): `supported` (`fail_closed_for_mutation: false`).
  - Non-versioned or unevidenced: `unknown-version` (`fail_closed_for_mutation: true`).
  - Explicit `"incompatible"`: `incompatible` (`fail_closed_for_mutation: true`).

## Config Files, Scopes, & Precedence
- **Host Config Files:**
  - User/Global Scope:
    - `~/.cursor/mcp.json` (global MCP servers)
    - `~/.cursor/settings.json`
    - `~/.config/Cursor/User/settings.json`
  - Project Scope:
    - `<workspace>/.cursor/settings.json` (primary project settings)
    - `<workspace>/.cursor/mcp.json` (project MCP servers)
    - `<workspace>/.cursorrules`
- **Config Hierarchy & Precedence:**
  - Workspace project configuration (`.cursor/settings.json`, `.cursor/mcp.json`) strictly overrides user configuration.
  - User configuration serves as fallback defaults.
  - Runtime flags (`--model`, `--worktree`) override static configuration for the active agent session.
- **Scope Isolation:**
  - Project preview and apply strictly target `<workspace>/.cursor/settings.json` and `<workspace>/.cursor/mcp.json`.
  - User preview and apply strictly target `~/.cursor/settings.json` and `~/.cursor/mcp.json`.

## Model-Selection Mechanism
- **Host Mechanism:**
  - Configured via `cursor.model`, `cursor.models`, or `model` in `.cursor/settings.json`, or passed via `cursor-agent --model <model>`.
  - Supports parameterized model specifications with overrides: e.g. `'claude-opus-4-8[context=1m,effort=high,fast=false]'`.
  - Inspection surface: `cursor-agent models` (when authenticated) or `settings.json`.
  - Typical models: `gpt-5`, `sonnet-4-thinking`, `claude-3-7-sonnet`, `claude-3-5-sonnet`, `gpt-4o`, `cursor-small`.
- **Adapter Adaptation:**
  - Returns only evidenced models from config or environment; returns empty array `[]` when unevidenced.
  - Model selection capability is reported as `available` when explicit models are found, and `unknown` when unconfigured.

## Reasoning / Effort / Variant Mechanism
- **Host Mechanism:**
  - Governed by `cursor.reasoningEffort`, `cursor.reasoning`, `cursor.thinking`, or model bracket parameters `[effort=high]`.
  - Evidenced values when configured: `low`, `medium`, `high`.
- **Adapter Adaptation:**
  - Native field: `cursor.reasoningEffort`.
  - Honest reporting: reports `state = "unknown"` with `[]` supported effort values when unevidenced.
  - Policy mapping:
    - `"highest-supported"`: resolves to `"high"` or highest supported value.
    - `"lowest-sufficient"` / `"lowest-supported"`: resolves to `"low"` or lowest supported value.
    - `"configured"`: resolves to currently configured value.

## Agent / Subagent Mechanism, Workers, & Parallelism
- **Host Mechanism:**
  - Cursor Agent CLI supports isolated git worktrees (`--worktree [name]`) and self-hosted background workers (`cursor-agent worker`).
  - IDE settings expose `cursor.parallelAgents`, `cursor.composer.parallelAgents`, `cursor.backgroundAgent`, and concurrency controls (`cursor.maxConcurrency`).
- **Adapter Adaptation:**
  - When parallel agents or background execution are enabled in settings: reports subagents and parallelism as `available` with configured `max_concurrency`.
  - In a clean unconfigured workspace: reports subagents and parallelism as `unknown`, with `supports_subagents: false` and `supports_parallel_execution: false`.

## MCP Support, Registration Mechanism, Scopes, & Doctor/Status
- **Host Mechanism:**
  - Format: JSON/JSONC with top-level `mcpServers` object:
    ```json
    {
      "mcpServers": {
        "agent-config": {
          "command": "agent-config",
          "args": ["serve"]
        }
      }
    }
    ```
  - Project Scope: `<workspace>/.cursor/mcp.json`
  - Global/User Scope: `~/.cursor/mcp.json`
  - Native CLI commands:
    - `cursor-agent mcp list` (verifies configured servers in `.cursor/mcp.json` or `~/.cursor/mcp.json` and reports approval status)
    - `cursor-agent mcp list-tools <id>`
    - `cursor --add-mcp <json>` (adds MCP server definition)
- **Adapter Adaptation:**
  - Previews generate unified diffs with cryptographic baseline hash and preview hash (`FrozenMutationPreview`).
  - Strict scope fidelity: project preview -> project apply; user preview -> user apply.
  - Safe parsing with `jsonc-parser`: preserves comments and structure, fails closed on malformed files.
  - Prioritizes CLI inspection (`cursor-agent mcp list` or `cursor mcp list`) where supported, with robust fallback to authentic `.cursor/mcp.json` file parsing.

## Machine-Readable Inspection Surfaces
- Config files: `.cursor/settings.json`, `.cursor/mcp.json`, `~/.cursor/mcp.json`, `~/.cursor/settings.json`.
- CLI commands: `cursor-agent --version`, `cursor-agent about`, `cursor-agent mcp list`, `cursor --version`.

## Writable Configuration Targets & Protected Configuration
- **Writable Targets:**
  - Project Scope: `<workspace>/.cursor/settings.json` (model, reasoning), `<workspace>/.cursor/mcp.json` (companion MCP server).
  - User Scope: `~/.cursor/settings.json`, `~/.cursor/mcp.json`.
- **Protected / Managed Configuration:**
  - Cursor extensions, auth tokens, session caches, and unrelated settings keys are preserved untouched during mutation.

## Known Available, Unavailable, & Unknown Capabilities
- **Available Capabilities (when evidenced):**
  - Project and user configuration mutation via JSON/JSONC.
  - Top-level `mcpServers` registration in `.cursor/mcp.json` and `~/.cursor/mcp.json`.
  - Model selection when configured in settings.
  - Parallel background agents and worktree support when explicitly enabled.
- **Unavailable Capabilities:**
  - Live dynamic model changes in streaming session without file persistence or restart.
- **Unknown Capabilities:**
  - Model selection is `unknown` when no models are configured in settings.
  - Subagents and parallelism are `unknown` when unconfigured.

## Mutation Strategy & Validation Strategy
- **Mutation Strategy:**
  - Strict 2-phase lifecycle: frozen previews with unified diffs, cryptographic hashes, and exact target paths.
  - Apply checks preview hash and target file content to prevent silent drift or overwrites.
- **Validation Strategy:**
  - Post-apply validation verifies that target model and reasoning effort match the applied execution plan, and that the companion MCP server is correctly registered in the effective JSON structure.
