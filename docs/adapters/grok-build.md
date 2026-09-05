# Grok Build Adapter Evidence Record (§10, §24, §44, §45, §46, §47, §48)

## 1. Adapter ID & Harness Identity
- **Adapter ID**: `grok-build`
- **Product / Harness Identity**: Grok Build / Grok CLI (`grok` executable)
- **Harness ID**: `grok-build`
- **Binary / Executable Names**: `grok` (located e.g. at `/Users/light/.local/bin/grok` or in PATH)
- **Runtime Environment Markers**:
  - `GROK_BUILD` (`1` or `true`)
  - `GROK_HOME` (directory pointing to user/installation home, default `~/.grok`)
  - `GROK_SESSION` or `GROK_SESSION_ID` (active session token/UUID)
  - `GROK_PROJECT_DIR` (project workspace root)
  - `GROK_CONFIG_DIR` (configuration directory override)
  - `GROK_VERSION` (version string)
  - Active process title or binary basename matching `grok`

## 2. Version Checked & Date Checked
- **Version Checked**: `grok 1.0.13 (5e9a58528b76)` (verified on host environment)
- **Date Checked**: 2026-09-05
- **Compatibility Classification**:
  - `0.x`, `1.x`: `supported` (`fail_closed_for_mutation: false`)
  - `2.x`: `partially-supported` (`fail_closed_for_mutation: false`)
  - Explicit `"incompatible"`: `incompatible` (`fail_closed_for_mutation: true`)
  - Unevidenced or unversioned: `unknown-version` (`fail_closed_for_mutation: true`)

## 3. Official Upstream, Documentation, & Config Schema Sources
- **Official Upstream**: xAI Grok Build CLI
- **Official Documentation**: Built-in CLI help surfaces:
  - `grok --help`
  - `grok inspect --help` (supports `--json` output)
  - `grok mcp --help` (`list`, `add`, `remove`, `enable`, `disable`, `doctor`)
  - `grok mcp add --help` (supports `-s, --scope <user|project>`, `--transport <stdio|http|sse>`, `--env`, `--header`, `--`)
  - `grok mcp list --help` (supports `--json`)
  - `grok doctor --help`
- **Official Config/Schema Source**: TOML configuration schema read from:
  - User configuration: `~/.grok/config.toml` or `$GROK_HOME/config.toml`
  - Project configuration: `<workspace>/.grok/config.toml` or `<workspace>/grok.toml`
  - MCP tables: `[mcp_servers.<name>]` and `[mcp.servers.<name>]` (both recognized; `[mcp_servers.<name>]` standard)
  - Model configuration: `[models] default = "..."` or top-level `model = "..."`
  - Agent specifications: `<workspace>/.grok/agents/*.toml`

## 4. Executable Detection & Version Detection
- **Executable Detection**:
  - Active runtime context: `GROK_BUILD`, `GROK_HOME`, `GROK_SESSION`, `GROK_SESSION_ID`, `GROK_PROJECT_DIR`, `GROK_CONFIG_DIR`, or `GROK_VERSION`.
  - PATH lookup: `which grok`.
  - Workspace markers: `<workspace>/.grok/`, `<workspace>/.grok/config.toml`, or `<workspace>/grok.toml`.
  - User markers: `$GROK_HOME/` or `~/.grok/`.
- **Version Detection**:
  1. Priority 1: Machine-readable inspection CLI `grok inspect --json` (`grokVersion` or `version` field).
  2. Priority 2: CLI output `grok --version` or `grok -v` (e.g. `grok 1.0.13 (5e9a58528b76)`).
  3. Priority 3: Process environment variable `GROK_VERSION`.
  4. Priority 4: File markers `<workspace>/.grok/version` or `$GROK_HOME/version`.

## 5. Config Files, Scopes, & Precedence (§46)
- **Configuration Hierarchy**:
  - **Policy Layer**: `$GROK_POLICY_FILE`, `/etc/grok/policy.toml`, `<workspace>/.grok/policy.toml`, `<workspace>/policy.toml`
  - **Managed Layer**: `$GROK_MANAGED_CONFIG`, `/etc/grok/managed.toml`, `/etc/grok/config.toml`, `<workspace>/.grok/managed.toml`
  - **Project Layer**: `<workspace>/.grok/config.toml` (canonical), `<workspace>/grok.toml`, `<workspace>/.grok/agents/*.toml`
  - **User Layer**: `$GROK_HOME/config.toml`, `~/.grok/config.toml`, `~/.config/grok/config.toml`
- **Precedence Order**:
  `Policy` > `Managed` > `Project` > `User`
- **In-Memory Merging Only**:
  Effective configuration is deep-merged in memory according to precedence.
- **Strict Prohibition Against Flattening**:
  Under no circumstances is effective configuration flattened or written to disk.
- **Strict Scope Isolation & Mutation Safety (§48)**:
  - Preview project scope -> apply modifies ONLY project configuration (`<workspace>/.grok/config.toml` and `.grok/agents/*.toml`).
  - Preview user scope -> apply modifies ONLY user configuration (`~/.grok/config.toml`).
  - Apply must NEVER spill to the wrong scope or overwrite protected layers.
- **Managed and Policy Layer Protection**:
  - If policy or managed layer specifies a locked model, configuration mutation overriding that model fails closed with a `Policy violation` error.
  - If policy specifies `deny_mutation = true`, all previews and applies fail closed.
  - Policy and managed file paths are strictly read-only and never included in `mutation_targets`.

## 6. Model-Selection Mechanism
- **Host Mechanism**:
  - Configured via `[models] default = "..."` or `model = "..."` in `config.toml`, or CLI flag `-m, --model <MODEL>`.
  - Machine-readable inspect `grok inspect --json` reports active and available models.
- **Adapter Adaptation**:
  - Discovers models through `grok inspect --json` (reporting kind `host-runtime` and locator `grok inspect --json`).
  - Falls back to reading layered TOML files (reporting kind `host-config`).
  - Never fabricates unevidenced OpenAI or Anthropic models if none are configured in Grok Build.
  - Returns `[]` in clean unconfigured environments.

## 7. Reasoning / Effort / Variant Mechanism
- **Native Field**: `reasoning_effort` (also supported via CLI flag `--reasoning-effort <EFFORT>` / `--effort`).
- **Supported Values**: Defined in `supported_effort_values` array or configured `reasoning_effort`.
- **Policy Mapping**:
  - `highest-supported`: maps to `xhigh` > `high` > `max` > highest evidenced value.
  - `lowest-sufficient` / `lowest-supported`: maps to `low` > `min` > lowest evidenced value.
  - `configured`: maps to current default/configured value.

## 8. Agent / Subagent Mechanism, Workers, & Parallelism (§48)
- **Subagents**:
  - Discovered via `subagents.enabled` in `grok inspect --json`, `subagents = true` in config, existence of `<workspace>/.grok/agents/`, or `GROK_SUBAGENTS=1`.
  - Reports `unknown` when unevidenced.
- **Parallelism & Concurrency**:
  - Conformance invariant: Parallelism is reported as `available` **only** when `max_concurrency > 1` is explicitly confirmed (via `max_concurrency` in config, runtime inspect, or `GROK_MAX_CONCURRENCY`).
  - Otherwise reports `unknown` and topology reports `supports_parallel_execution: false`.
- **Worktree Isolation**:
  - Supported via CLI flag `-w, --worktree [<WORKTREE>]` and `grok worktree` subcommands.
- **Per-Agent Model Selection**:
  - Inspected via `subagents.agent_specific_model` in runtime inspect, `worker_model` in config, or individual `.grok/agents/*.toml` files.
  - Decomposed plans render per-agent configuration files under `<workspace>/.grok/agents/<ticket_id>.toml`.

## 9. MCP Support, Registration Mechanism, Scopes, & Doctor/Status (§47)
- **Host Mechanism**:
  - Native CLI command:
    - Add to project: `grok mcp add --scope project <NAME> -- <COMMAND> [ARGS]...`
    - Add to user: `grok mcp add --scope user <NAME> -- <COMMAND> [ARGS]...`
    - List: `grok mcp list --json` or `grok mcp list`
    - Doctor: `grok mcp doctor [NAME]`
  - TOML Table Names:
    - Standard: `[mcp_servers.<name>]`
      ```toml
      [mcp_servers.agent-config]
      command = "agent-config"
      args = [
          "serve",
      ]
      ```
    - Legacy compatible: `[mcp.servers.<name>]`
  - Targets:
    - Project scope: `<workspace>/.grok/config.toml`
    - User scope: `~/.grok/config.toml` or `$GROK_HOME/config.toml`
- **Companion Setup Lifecycle**:
  1. Inspect existing MCP servers via `grok inspect --json`, `grok mcp list --json`, or TOML reading.
  2. Determine target file strictly respecting scope (`project` vs `user`/`global`).
  3. Preview configuration patch with unified diff and cryptographic SHA-256 hash.
  4. Require explicit approval (preview hash verification).
  5. Apply: prioritize native CLI `grok mcp add --scope <project|user> agent-config -- agent-config serve`; fall back to direct atomic TOML modification.
  6. Read-back validation verifying registration.

## 10. Machine-Readable Inspection Surfaces
- `grok inspect --json`: Emits complete machine-readable state including `grokVersion`, `cwd`, `projectRoot`, `projectInstructions`, `permissions`, `skills`, `agents`, `mcpServers`, `configSources`, and `externalCompat`.
- `grok mcp list --json`: Emits JSON array of configured MCP servers with `name`, `command`, `args`, `enabled`, `scope`, and `startup_timeout_sec`.
- `grok mcp doctor --json`: Diagnoses MCP server connectivity and configuration.

## 11. Writable Configuration Targets & Managed Configuration
- **Writable Targets**:
  - Project scope: `<workspace>/.grok/config.toml`, `<workspace>/.grok/agents/<ticket_id>.toml`
  - User scope: `~/.grok/config.toml` (or `$GROK_HOME/config.toml`)
- **Protected / Managed Targets**:
  - Policy files (`/etc/grok/policy.toml`, `.grok/policy.toml`)
  - Managed files (`/etc/grok/managed.toml`, `/etc/grok/config.toml`, `.grok/managed.toml`)
  - Attempts to mutate protected layers fail closed.

## 12. Known Capabilities Matrix
- **Available**:
  - Subagents (when evidenced)
  - Concurrency / Parallelism (when `max_concurrency > 1` evidenced)
  - Model selection (when models evidenced)
  - Reasoning effort (when effort values evidenced)
  - Scope-isolated configuration mutation (project vs user)
  - Native MCP registration via `grok mcp add` and TOML
- **Unavailable**:
  - Dynamic in-memory session mutation without file persistence (`supports_session_mutation: false`)
- **Unknown**:
  - Subagents when no agent directory or subagents flag is present
  - Parallelism when concurrency ceiling is unevidenced
  - Models and reasoning effort when clean unconfigured workspace
