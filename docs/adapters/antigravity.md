# Antigravity Adapter Evidence Record

## Adapter ID
- **Adapter ID:** `antigravity` (aliases / compatibility fallback: `gemini-cli`)

## Product / Harness Identity
- **Product Name:** Google Antigravity / Gemini CLI family (formerly codenamed Jetski / Gemini CLI)
- **Harness ID:** `antigravity`
- **Binary / Executable Names:**
  - Desktop Application: `/Applications/Antigravity.app/Contents/MacOS/Antigravity` (app bundle: `com.google.antigravity`)
  - Embedded Language Server / Agent API: `/Applications/Antigravity.app/Contents/Resources/bin/language_server`, `~/.gemini/antigravity/bin/agentapi`
  - Historical / Command Line interface: `gemini`, `gemini-cli`
- **Runtime Environment Markers:**
  - `GEMINI_CLI` (`1` or `true`)
  - `GEMINI_PROJECT_DIR`
  - `GEMINI_SESSION_ID`
  - `GEMINI_CONFIG_DIR`
  - `GEMINI_HOME`
  - `ANTIGRAVITY_HOME`
  - `ANTIGRAVITY_APP_DATA_DIR`
  - Active process title or binary basename containing `antigravity` or `gemini`

## Version Checked & Date Checked
- **Version Checked:** `2.11.0` (Antigravity macOS Desktop `com.google.antigravity` 2.11.0 with embedded language server 2.11.0, updating to 2.12.2)
- **Date Checked:** 2026-09-05

## Official Upstream, Documentation, & Config Schema Sources
- **Official Upstream:** Google Antigravity (`https://antigravity-hub-auto-updater-974169037036.us-central1.run.app`, Google internal codename `jetski` / `//third_party/jetski/language_server`)
- **Official Documentation:** Embedded language server help (`language_server --help`), Antigravity Hub runtime bridge.
- **Official Config/Schema Source:**
  - User Settings & Project Registry: `$GEMINI_CONFIG_DIR/config.json` (default `~/.gemini/config/config.json`), `$GEMINI_CONFIG_DIR/projects/*.json`
  - State & Model History: `~/.gemini/antigravity/antigravity_state.pbtxt`
  - MCP Server Configuration: `$GEMINI_CONFIG_DIR/mcp_config.json` (or `.gemini/config.json`, `.gemini/mcp.json`)
  - Skills Directory: `~/.gemini/config/skills.json` and symlinked `~/.gemini/config/skills` -> `~/.agents/skills`

## Relationship between Antigravity and Gemini CLI
- **Evidence from local environment and binary symbols:**
  - Antigravity is Google's desktop agent IDE and language server (evolved from the Google internal `jetski` project).
  - The embedded engine specifically sets `--gemini_dir=".gemini"`, `--config_dir="config"`, `--app_data_dir="antigravity"`, and connects to Google Cloud Code PA (`cloud_code_endpoint`) and Gemini generative service endpoints.
  - Its user configurations, skills, project resources, and MCP definitions live in `~/.gemini/config/` and workspace `.gemini/` directories.
  - Therefore, `antigravity` and `gemini-cli` share the same configuration root format (`.gemini/`), while Antigravity represents the current active Google desktop agent platform.
  - In `agent-config`, the canonical identifier is frozen as `antigravity` (with `gemini-cli` retained as an alias for backwards compatibility and CLI execution).

## Executable Detection & Version Detection
- **Executable Detection:**
  - Active process check: runtime environment variables (`GEMINI_CLI`, `GEMINI_PROJECT_DIR`, `GEMINI_SESSION_ID`, `GEMINI_CONFIG_DIR`, `GEMINI_HOME`), or process title/path matching `antigravity` or `gemini`.
  - Application bundle check: `/Applications/Antigravity.app/Contents/MacOS/Antigravity` or `/Applications/Antigravity.app/Contents/Resources/bin/language_server` or `~/.gemini/antigravity/bin/agentapi`.
  - PATH lookup: `which gemini`, `which gemini-cli`, `which antigravity`.
  - Workspace markers: presence of `.gemini/` directory, `.gemini/config.json`, `.gemini/settings.json`, or `gemini.json`.
  - User markers: presence of `~/.gemini/antigravity/`, `~/.gemini/config/`, or `~/.gemini/config.json`.
- **Version Detection:**
  - Environment variable: `GEMINI_CLI_VERSION`, `GEMINI_VERSION`, `ANTIGRAVITY_VERSION`.
  - File markers: `<workspace>/.gemini/version`, `~/.gemini/version`, or reading version from `Antigravity.app/Contents/Info.plist` (`CFBundleShortVersionString`).
  - CLI execution: `gemini --version` or `language_server stamp`.
- **Compatibility Classification:**
  - `0.x`, `1.x`, `2.x`: `supported` (`fail_closed_for_mutation: false`)
  - Major > 2: `partially-supported`
  - Non-versioned or unevidenced: `unknown-version` (`fail_closed_for_mutation: true`)
  - Explicit `"incompatible"`: `incompatible` (`fail_closed_for_mutation: true`)

## Config Files, Scopes, & Precedence
- **Host Config Files:**
  - User/Global Scope:
    - `~/.gemini/config/config.json`
    - `~/.gemini/config/mcp_config.json`
    - `~/.gemini/config.json`
    - `~/.config/gemini/config.json`
    - `~/.gemini/settings.json`
    - `~/.gemini/mcp.json`
  - Project Scope:
    - `<workspace>/.gemini/config.json` (primary project settings)
    - `<workspace>/.gemini/settings.json`
    - `<workspace>/gemini.json`
    - `<workspace>/.gemini/mcp.json`
- **Config Hierarchy & Precedence:**
  - Workspace project configuration (`.gemini/config.json`, `.gemini/settings.json`, `gemini.json`) overrides user configuration.
  - User configuration (`~/.gemini/config/config.json`, `~/.gemini/config.json`) serves as fallback defaults.
  - Environment overrides take highest precedence for session-level execution.
- **Scope Isolation:**
  - Project preview and apply strictly target `<workspace>/.gemini/config.json` (or `.gemini/mcp.json`).
  - Global/user preview and apply strictly target user-level configuration in `~/.gemini/config.json` or `~/.gemini/config/mcp_config.json`.

## Model-Selection Mechanism
- **Host Mechanism:**
  - Configured via `model`, `fallback_model`, `available_models`, `models` keys in `.gemini/config.json` or `config.json`.
  - Antigravity state persistence records active model choices (e.g. `last_selected_agent_model` in `antigravity_state.pbtxt`).
  - Runtime CLI parameter: `--override_model_name=<MODEL>` on `language_server`.
  - Typical models: `gemini-2.5-pro`, `gemini-2.0-flash`, `gemini-2.0-pro`, `gemini-1.5-pro`.
- **Adapter Adaptation:**
  - Returns only evidenced models from config or environment; returns empty array `[]` when unevidenced without fabricating model names.
  - Model selection capability is reported as `available` when explicit models are found, and `unknown` when unconfigured.

## Reasoning / Effort / Variant Mechanism
- **Host Mechanism:**
  - Governed by `reasoning_effort`, `thinking_budget`, or `thinking.effort` in `.gemini/config.json` or `userSettings`.
  - Evidenced values when configured: `low`, `medium`, `high`.
- **Adapter Adaptation:**
  - Native field: `reasoning_effort`.
  - Honest reporting: reports `state = "unavailable"` (or `"unknown"`) with `[]` supported effort values when unevidenced in host configuration.
  - Policy mapping:
    - `"highest-supported"`: resolves to `"high"` or highest supported value.
    - `"lowest-sufficient"` / `"lowest-supported"`: resolves to `"low"` or lowest supported value.
    - `"configured"`: resolves to currently configured value.

## Agent / Subagent Mechanism, Workers, & Parallelism
- **Host Mechanism:**
  - Antigravity / Gemini CLI executes single-session or IDE-managed task sessions.
  - Does NOT expose arbitrary child subagent worker file hierarchies or parallel CLI subagent orchestration in user project workspaces.
  - Concurrency is bounded (`max_concurrency: 1` for standalone CLI execution; language server caps worker procs via `limit_go_max_procs`).
- **Adapter Adaptation:**
  - Rejects prior unsupported assumptions: does NOT claim subagent file hierarchies or multi-agent CLI workers without host evidence.
  - Subagents capability is honestly reported as `unavailable` (or `unknown` in non-runtime detection), with `supports_subagents: false`.
  - Parallelism is reported as `unavailable`, with `supports_parallel_execution: false` and `max_concurrency: 1`.

## MCP Support, Registration Mechanism, Scopes, & Doctor/Status
- **Host Mechanism:**
  - Supported via JSON/JSONC configuration files containing either:
    - Nested `mcp.servers`: `{ "mcp": { "servers": { "agent-config": { "command": "...", "args": [...] } } } }`
    - Top-level `mcpServers`: `{ "mcpServers": { "agent-config": { "command": "...", "args": [...] } } }`
  - In Antigravity desktop: also supports `$GEMINI_CONFIG_DIR/mcp_config.json` or project `.gemini/mcp.json`.
  - Embedded language server includes built-in Chrome DevTools MCP server (`-use_ls_chrome_devtools_mcp=true`).
- **Adapter Adaptation:**
  - Registration scopes:
    - Project scope: `<workspace>/.gemini/config.json` or `.gemini/mcp.json`
    - Global/user scope: `~/.gemini/config.json` or `~/.gemini/config/mcp_config.json`
  - Previews generate unified diffs with cryptographic baseline hash and preview hash (`FrozenMutationPreview`).
  - Strict scope fidelity: project preview -> project apply; user preview -> user apply.
  - Safe parsing with `jsonc-parser`: preserves formatting, comments, and trailing commas; fails closed on malformed files.

## Machine-Readable Inspection Surfaces
- Config files: `.gemini/config.json`, `.gemini/settings.json`, `gemini.json`, `.gemini/mcp.json`, `~/.gemini/config/config.json`, `~/.gemini/config/mcp_config.json`.
- State files: `~/.gemini/antigravity/antigravity_state.pbtxt`.
- CLI commands: `gemini --version`, `language_server --help`.

## Writable Configuration Targets & Protected Configuration
- **Writable Targets:**
  - Project Scope: `<workspace>/.gemini/config.json` (model, reasoning, MCP servers)
  - User Scope: `~/.gemini/config.json`
- **Protected / Managed Configuration:**
  - Unrelated keys in `config.json` (such as `userSettings.artifactReviewMode`, `globalPermissionGrants`, `remoteControlHostname`) are preserved untouched during mutation.
  - Auth tokens (`jetski-standalone-oauth-token`), conversation databases (`conversations/*.db`), and protobuf summaries (`agyhub_summaries_proto.pb`) are never modified.

## Known Available, Unavailable, & Unknown Capabilities
- **Available Capabilities (when evidenced):**
  - Project and user configuration mutation via JSON/JSONC.
  - Model selection when configured in project or user configuration.
  - MCP server companion registration under `mcp.servers` or `mcpServers`.
  - Discrete reasoning effort controls (`low`, `medium`, `high`) when present in configuration.
- **Unavailable Capabilities:**
  - Native child subagent orchestration via project configuration files.
  - Isolated per-worker model assignment files.
  - Parallel background CLI worker execution loops.
- **Unknown Capabilities:**
  - Model selection is `unknown` when no models are evidenced in configuration.
  - Dynamic token rate limits and cloud service quota states without live API queries.

## Mutation Strategy & Validation Strategy
- **Mutation Strategy:**
  - Strict 2-phase lifecycle: frozen previews with unified diffs, cryptographic hashes, and exact target paths.
  - Apply checks preview hash and target file content to prevent silent drift or overwrites.
- **Validation Strategy:**
  - Post-apply validation verifies that target model and reasoning effort match the applied execution plan, and that the companion MCP server is correctly registered in the effective JSON structure.
