# Grok Build Adapter Evidence Record (§24, §44, §45, §46, §47, §48)

## 1. Harness Identity
- **Harness ID**: `grok-build`
- **Adapter ID**: `grok-build`
- **Name**: Grok Build Adapter
- **Runtime Environment Markers**:
  - `GROK_BUILD` (`1` or `true`)
  - `GROK_HOME` (directory pointing to user/installation home)
  - `GROK_SESSION` or `GROK_SESSION_ID` (active session token/UUID)
  - `GROK_PROJECT_DIR` (project workspace root)
  - `GROK_CONFIG_DIR` (configuration directory override)
  - `GROK_VERSION` (version string)
  - Process ancestry or executable title matching `grok` or `grok-build`

## 2. Supported Versions (§21, §22, §44)
- **Supported Releases**: `0.x`, `1.x` (stable releases with configuration mutation enabled: `fail_closed_for_mutation: false`).
- **Partially Supported Releases**: `2.x` (partially supported: `fail_closed_for_mutation: false`).
- **Incompatible Builds**: Builds reporting `incompatible` or explicit breaking interfaces fail closed (`fail_closed_for_mutation: true`).
- **Unevidenced Environments**: When version is unknown/unevidenced, reports `unknown-version` and fails closed for mutation (`fail_closed_for_mutation: true`).
- **Version Sources**:
  1. Machine-readable inspection CLI: `grok inspect --json` (`version` field) (§45).
  2. CLI output: `grok --version`.
  3. Process environment: `GROK_VERSION`.
  4. Workspace marker: `<workspace>/.grok/version`.
  5. User home marker: `$GROK_HOME/version` or `~/.grok/version`.

## 3. Evidence Sources & Runtime Inspection Priority (§45)
- **Priority 1: Runtime Inspection (`grok inspect --json`)**:
  - If the host CLI supports `grok inspect --json` or equivalent machine-readable command, runtime inspection takes precedence over manual TOML parsing.
  - Models discovered through runtime inspection report evidence kind `host-runtime` with locator `"grok inspect --json"`.
  - Subagents, parallelism, worktrees, reasoning effort, and MCP server registrations are discovered from the JSON output.
- **Priority 2: Layered Configuration Fallback**:
  - If runtime inspection fails or the CLI is unavailable, the adapter falls back to reading layered TOML files.
  - Models discovered from configuration files report evidence kind `host-config` with the respective file path.
- **Strict Unknown Semantics**:
  - Unevidenced capabilities remain `unknown`.
  - The adapter never invents default OpenAI or Anthropic models if none are configured in Grok Build.

## 4. Config Locations & Hierarchy
- **Policy / Requirements Layer**:
  - `$GROK_POLICY_FILE`
  - `/etc/grok/policy.toml`
  - `<workspace>/.grok/policy.toml`
  - `<workspace>/policy.toml`
- **Managed / Org Layer**:
  - `$GROK_MANAGED_CONFIG`
  - `/etc/grok/managed.toml`
  - `/etc/grok/config.toml`
  - `<workspace>/.grok/managed.toml`
- **Project Layer**:
  - `<workspace>/.grok/config.toml` (canonical project configuration)
  - `<workspace>/grok.toml` (root-level project alternative)
  - `<workspace>/.grok/agents/*.toml` (subagent specifications)
- **User Layer**:
  - `$GROK_HOME/config.toml`
  - `~/.grok/config.toml`
  - `~/.config/grok/config.toml`

## 5. Config Precedence & Policy Protection (§46)
- **Hierarchy Precedence**:
  `Policy` > `Managed` > `Project` > `User`
- **In-Memory Merging Only**:
  Effective configuration is calculated in-memory by deep-merging layers according to precedence.
- **Strict Prohibition Against Flattening**:
  Under no circumstances is effective configuration flattened or written into `~/.grok/config.toml`.
  When a workspace root is present, mutations strictly target `<workspace>/.grok/config.toml` and `<workspace>/.grok/agents/<ticket_id>.toml`. The user home configuration remains untouched.
- **Managed and Policy Layer Protection**:
  - Managed and policy layers are strictly protected from overrides.
  - If a policy or managed layer defines a locked model (`model = "..."`), any configuration plan targeting a different model fails closed with a `Policy violation` error.
  - If a policy defines `deny_mutation = true`, all configuration mutation previews and applies are rejected.
  - Policy and managed file paths are never included in `mutation_targets`.

## 6. MCP Mechanism (§47)
- **Configuration Path**:
  - Project Scope: `<workspace>/.grok/config.toml` (under `[mcp.servers.agent-config]`)
  - User Scope: `~/.grok/config.toml` or `$GROK_HOME/config.toml`
- **Table Format**:
  ```toml
  [mcp.servers.agent-config]
  command = "agent-config"
  args = ["serve"]
  ```
- **Companion Setup Lifecycle**:
  1. Inspect existing MCP servers via `grok inspect --json` or TOML parsing.
  2. Determine effective source and valid writable target (`<workspace>/.grok/config.toml`).
  3. Preview configuration patch with unified diff and cryptographic SHA-256 hash.
  4. Require explicit approval (preview hash verification).
  5. Prioritize host command `grok mcp add` if supported; fall back to atomic TOML update.
  6. Validate registration via read-back.

## 7. Model Mechanism
- **Model Keys**:
  - Primary Model: `model` key in `config.toml` or `model` in runtime inspect.
  - Worker Model: `worker_model` in `config.toml` or runtime inspect.
  - Inventory: `models` or `supported_models` array in `config.toml` or runtime inspect.
- **Authentic Reporting**: Returns only verified models. In clean unconfigured workspaces, returns `[]` without fabricating default model arrays.

## 8. Reasoning Mechanism
- **Native Field**: `reasoning_effort`.
- **Supported Values**: Defined in `supported_effort_values` array or configured `reasoning_effort`.
- **Policy Mapping**:
  - `highest-supported`: maps to `xhigh` > `high` > `max` > highest evidenced value.
  - `lowest-sufficient` / `lowest-supported`: maps to `low` > `min` > lowest evidenced value.
  - `configured`: maps to current default/configured value.

## 9. Subagents, Parallelism & Worktree Mechanism (§48)
- **Authentic Individual Inspection**:
  Each capability is inspected and reported honestly; presence of Grok Build does not grant blanket availability.
- **Subagents**:
  - `available` only when runtime inspect reports `subagents.enabled = true`, or config sets `subagents = true`, or `<workspace>/.grok/agents/` directory exists, or `GROK_SUBAGENTS=1`.
  - Otherwise reports `unknown` (or `unavailable` if explicitly disabled).
- **Parallelism & Concurrency**:
  - Conformance invariant: Parallelism is reported as `available` **only** when `max_concurrency > 1` is explicitly confirmed (via `max_concurrency` in config, runtime inspect, or `GROK_MAX_CONCURRENCY`).
  - Without confirmed concurrency > 1, parallelism reports `unknown`.
- **Worktree Isolation**:
  - Inspected via `worktree_isolation` or `subagents.worktrees` in runtime inspect, `worktrees = true` in config, or `<workspace>/.grok/worktrees` directory.
- **Per-Agent Model Selection**:
  - Inspected via `subagents.agent_specific_model` in runtime inspect, `worker_model` in config, or individual `.grok/agents/*.toml` files.

## 10. Mutation Targets & Isolation
- Single-pass plan renders to `<workspace>/.grok/config.toml`.
- Decomposed plan renders main controller model to `<workspace>/.grok/config.toml` and individual worker agent configurations to `<workspace>/.grok/agents/<ticket_id>.toml`.
- All mutation targets must reside strictly within workspace boundaries (or user home if operating without workspace).

## 11. Apply Validation (§74)
Configuration validation reads back effective host state (via runtime inspection or layered TOML config) and verifies:
1. `Controller Model`: matches `expected.execution.model` or `expected.controller.model`.
2. `Reasoning Effort`: matches expected reasoning effort if specified.
3. `Worker Models & Effort`: for decomposed tasks, verifies each `<workspace>/.grok/agents/<ticket_id>.toml` file.

## 12. Known Unsupported Capabilities
- Dynamic in-memory session mutation without file persistence (`supports_session_mutation: false`).

## 13. Known Unknown Capabilities
- Model selection is `unknown` when no models are configured or exposed in runtime inspection.
- Reasoning is `unknown` when effort values are absent from host configuration.
