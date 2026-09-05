# Codex Adapter Evidence Record

## Adapter ID
- **Adapter ID:** `codex`

## Product / Harness Identity
- **Product Name:** Codex / OpenAI Codex CLI
- **Harness ID:** `codex`
- **Binary / Executable Names:** `codex` (CLI bundled with OpenAI ChatGPT desktop / plugins, e.g. `/Applications/ChatGPT.app/Contents/Resources/codex` or `~/.codex/plugins/.plugin-appserver/codex` or PATH `codex`)
- **Runtime Environment Markers:**
  - `CODEX_THREAD_ID`
  - `CODEX_SESSION_ID`
  - `CODEX_WORKSPACE`
  - `CODEX_HOME`
  - Active process title or binary basename matching `codex`

## Version Checked & Date Checked
- **Version Checked:** `codex-cli 0.153.3` (installed on local host via `/Applications/ChatGPT.app/Contents/Resources/codex` and `~/.codex/plugins/.plugin-appserver/codex`)
- **Date Checked:** 2026-09-05

## Official Upstream, Documentation, & Config Schema Sources
- **Official Upstream:** OpenAI Codex (`codex-cli`)
- **Official Documentation:** Built-in CLI help (`codex --help`, `codex exec --help`, `codex mcp --help`, `codex doctor --help`)
- **Official Config/Schema Source:** TOML configuration schema read from `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`), per-agent TOML files under `.codex/agents/*.toml`, and secondary fallback `mcp.json`.

## Executable Detection & Version Detection
- **Executable Detection:**
  - Active process check: `CODEX_THREAD_ID`, `CODEX_SESSION_ID`, `CODEX_WORKSPACE`, or process title/path.
  - PATH lookup: `which codex` or known installation paths (`/Applications/ChatGPT.app/Contents/Resources/codex`, `~/.codex/plugins/.plugin-appserver/codex`).
  - Workspace markers: presence of `.codex/` directory or `codex.toml`.
  - User markers: presence of `$CODEX_HOME` or `~/.codex/`.
- **Version Detection:**
  - Environment variable `CODEX_VERSION`.
  - CLI execution: `codex --version` or `codex -V` (emits e.g. `codex-cli 0.153.3`).
  - File markers: `<workspace>/.codex/version` or `$CODEX_HOME/version`.
- **Compatibility Classification:**
  - `0.x`, `1.x`: `supported` (`fail_closed_for_mutation: false`)
  - `2.x`: `partially-supported`
  - Non-versioned or unevidenced: `unknown-version` (`fail_closed_for_mutation: true`)
  - Explicit `"incompatible"`: `incompatible` (`fail_closed_for_mutation: true`)

## Config Files, Scopes, & Precedence
- **Host Config Files:**
  - User/Global Scope: `$CODEX_HOME/config.toml` (or `~/.codex/config.toml`), `$CODEX_HOME/agents/*.toml`.
  - Project Scope: `<workspace>/.codex/config.toml` (or `<workspace>/codex.toml`), `<workspace>/.codex/agents/*.toml`.
- **Config Hierarchy & Precedence:**
  - Project-level `<workspace>/.codex/config.toml` and `.codex/agents/*.toml` override user-level `$CODEX_HOME/config.toml`.
  - Environment overrides (`-c key=value` flags or runtime variables) take precedence over static configuration files.
  - Workspace inspection inspects the workspace layer first. Unconfigured workspaces do not fabricate models or reasoning effort.
- **Scope Isolation:**
  - Project preview and apply strictly target `<workspace>/.codex/`.
  - User preview and apply strictly target `$CODEX_HOME/` (or `~/.codex/`).

## Model-Selection Mechanism
- **Host Mechanism:**
  - Primary model configured via `model = "..."` key in `config.toml` or passed via CLI `--model <MODEL>` (`-m`).
  - Multi-model inventory evidenced via `supported_models = [...]` in `config.toml`, `models_cache.json`, or per-agent `model` in `.codex/agents/*.toml`.
- **Adapter Adaptation:**
  - Returns only evidenced models; if no models are configured or detected, returns an empty list `[]` without guessing unevidenced OpenAI or external models.
  - Model selection capability is reported as `available` when explicit models are found, and `unknown` when unconfigured.

## Reasoning / Effort / Variant Mechanism
- **Host Mechanism:**
  - Controlled by `model_reasoning_effort = "..."` in `config.toml` or per-agent configuration.
  - Evidenced discrete values: e.g. `"low"`, `"medium"`, `"high"`, `"xhigh"` (defined in `supported_effort_values` in `config.toml` or read from active configuration).
- **Adapter Adaptation:**
  - Native field: `model_reasoning_effort`.
  - Honest reporting: if `model_reasoning_effort` and `supported_effort_values` are absent from host configuration, reasoning capability reports `state = "unknown"` and supported effort values return `[]`. Does not inject synthesized `["low", "medium", "high"]`.
  - Policy mapping:
    - `"highest-supported"`: resolves to `"xhigh"` or `"high"` if evidenced, or highest supported value.
    - `"lowest-sufficient"` / `"lowest-supported"`: resolves to `"low"` or lowest supported value.
    - `"configured"`: resolves to current configured value.

## Agent / Subagent Mechanism, Workers, & Parallelism
- **Host Mechanism:**
  - Subagents/workers configured as TOML files under `.codex/agents/<agent_name>.toml` defining `name`, `model`, and optional `model_reasoning_effort`.
  - Concurrency configured via `max_concurrency = N` in `config.toml` or `CODEX_MAX_CONCURRENCY` environment variable.
- **Adapter Adaptation:**
  - Subagents capability is `available` only when `.codex/agents/` exists or subagents are configured/enabled. Otherwise reports `unknown` and topology reports `supports_subagents: false`.
  - Parallelism is `available` only when concurrency > 1 is evidenced. Otherwise reports `unknown` and topology reports `supports_parallel_execution: false`.
  - Worker configurations render isolated per-ticket files under `.codex/agents/<ticket_id>.toml`.

## MCP Support, Registration Mechanism, Scopes, & Doctor/Status
- **Host Mechanism:**
  - Native CLI command: `codex mcp add <NAME> -- <COMMAND>...` or `codex mcp list`, `codex mcp get <NAME>`, `codex mcp remove <NAME>`.
  - Canonical format: TOML configuration table in `config.toml`:
    ```toml
    [mcp_servers.agent-config]
    command = "agent-config"
    args = ["serve"]
    ```
  - Project Scope target: `<workspace>/.codex/config.toml`.
  - User/Global Scope target: `$CODEX_HOME/config.toml` or `~/.codex/config.toml`.
  - Legacy / Migration-Only Note: `.codex/mcp.json` is legacy/unsupported/migration-only for read-only inspection; it is NOT a current configuration surface or writable mutation target.
  - Doctor command: `codex doctor` verifies local config, auth, and runtime health.
- **Adapter Adaptation:**
  - Previews generate unified diffs with cryptographic baseline hash and preview hash (`FrozenMutationPreview`).
  - Scope is strictly preserved: project preview -> project apply; user preview -> user apply.
  - Inspection checks project scope first; falls back to user scope if unconfigured.
  - Doctor/validation validates TOML parsing, server command/args presence, and reachability.

## Machine-Readable Inspection Surfaces
- Config files: `.codex/config.toml`, `.codex/agents/*.toml` (legacy read-only inspection: `.codex/mcp.json`).
- CLI commands: `codex --version`, `codex mcp list`, `codex doctor`.
- State databases & caches: `models_cache.json`, `.codex-global-state.json`.

## Writable Configuration Targets & Protected Configuration
- **Writable Targets:**
  - Project Scope: `<workspace>/.codex/config.toml`, `<workspace>/.codex/agents/<ticket_id>.toml`.
  - User Scope: `$CODEX_HOME/config.toml`.
- **Protected / Managed Configuration:**
  - Unrelated keys in `config.toml` (e.g. `marketplaces`, `plugins`, `notify`, `personality`, `service_tier`) are preserved untouched during mutation.
  - Session databases (`*.sqlite`, `sessions/`) and auth credentials (`auth.json`) are strictly protected and never modified by adapter.

## Known Available, Unavailable, & Unknown Capabilities
- **Available Capabilities (when evidenced):**
  - Project and user configuration mutation via TOML.
  - Per-agent model and reasoning effort configuration under `.codex/agents/*.toml`.
  - MCP companion server registration in `<workspace>/.codex/config.toml` (`[mcp_servers.agent-config]`) or user `config.toml`.
  - Discrete reasoning effort controls (`low`, `medium`, `high`, `xhigh`).
- **Unavailable Capabilities:**
  - In-memory runtime session mutation without file persistence or session restart.
  - Writing companion configuration to `.codex/mcp.json` (canonical target is TOML `config.toml`).
- **Unknown Capabilities:**
  - Model selection is `unknown` when no models are configured in TOML or runtime environment.
  - Subagents and parallelism are `unknown` in clean unconfigured workspaces.

## Mutation Strategy & Validation Strategy
- **Mutation Strategy:**
  - Strict 2-phase lifecycle: `previewCompanionRegistration` / `previewConfiguration` produce frozen previews with unified diffs, explicit target paths, and SHA-256 hashes.
  - `applyCompanionRegistration` and `applyConfiguration` consume exact approved previews and fail closed on hash mismatch or file drift.
  - TOML modifications preserve non-target sections and keys.
- **Validation Strategy:**
  - Post-apply validation performs semantic verification:
    1. Effective `model` in `config.toml` matches expected controller/main model.
    2. Effective `model_reasoning_effort` in `config.toml` matches expected controller effort.
    3. Each worker file in `.codex/agents/<ticket_id>.toml` matches expected worker model and reasoning effort.
    4. MCP server entry in `mcp.json` is verified for syntax and command/args correctness.

