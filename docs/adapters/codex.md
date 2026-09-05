# Codex Adapter Evidence Record (§24)

## Harness Identity
- **Harness ID**: `codex`
- **Adapter ID**: `codex`
- **Name**: Codex Adapter
- **Runtime Process / Indicators**:
  - `process.env.CODEX_THREAD_ID`
  - `process.env.CODEX_SESSION_ID`
  - `process.env.CODEX_WORKSPACE`
  - `process.env.CODEX_HOME`
  - Executable name or title containing `codex`

## Supported Versions (§21, §22)
- **Supported**: `0.x`, `1.x`
- **Partially Supported**: `2.x`
- **Fail-Closed for Mutation**: Unknown versions or `incompatible` versions allow read-only inspection but fail-closed for configuration mutation.

## Evidence Sources
1. **Runtime Context**: `CODEX_THREAD_ID`, `CODEX_SESSION_ID`, `CODEX_WORKSPACE`, `CODEX_HOME`.
2. **Project Workspace**:
   - `<workspace>/.codex/config.toml` (or `<workspace>/codex.toml`)
   - `<workspace>/.codex/agents/*.toml`
   - `<workspace>/.codex/mcp.json`
   - `<workspace>/.codex/sessions/`, `session.db`, `state.db`
   - `<workspace>/.codex/version`
3. **User / Global Configuration**:
   - `$CODEX_HOME/config.toml` or `~/.codex/config.toml`
   - `$CODEX_HOME/agents/*.toml` or `~/.codex/agents/*.toml`
   - `$CODEX_HOME/mcp.json` or `~/.codex/mcp.json`
   - `$CODEX_HOME/version` or `~/.codex/version`

## Config Locations & Hierarchy
- **Project Scope**: `<workspace>/.codex/config.toml` (preferred) or `<workspace>/codex.toml`.
- **User / Global Scope**: `$CODEX_HOME/config.toml` or `~/.codex/config.toml`.
- **Subagents Directory**: `<workspace>/.codex/agents/*.toml` (project) and `~/.codex/agents/*.toml` (user).

## Config Precedence & Scope Isolation
- Project configuration overrides user configuration for `model`, `model_reasoning_effort`, `max_concurrency`, and individual subagents.
- Workspace inspection inspects the workspace project layer. Unconfigured workspaces do not inherit speculative models.
- Mutation targets the selected scope (default: project `<workspace>/.codex/config.toml` and `<workspace>/.codex/agents/<ticket>.toml`).

## MCP Mechanism
- **Configuration Path**:
  - Project Scope: `<workspace>/.codex/mcp.json`
  - User Scope: `~/.codex/mcp.json` (or `$CODEX_HOME/mcp.json`)
- **Format**:
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
- **Scope Handling**: Inspection checks project scope first; if not registered, checks user scope. Mutation targets the specified or workspace-appropriate scope.

## Model Mechanism (§25)
- **Primary Model**: `model` key in `config.toml`.
- **Supported Models**: `supported_models` array in `config.toml`.
- **Worker Models**: `worker_model` in `config.toml` or per-agent `model` in `.codex/agents/*.toml`.
- **Real Inspection**: Returns only evidenced models; if no models are configured or detected, returns an empty list without guessing default OpenAI or Anthropic models.

## Reasoning Mechanism (§25)
- **Native Field**: `model_reasoning_effort`.
- **Supported Values**: Defined in `supported_effort_values` in `config.toml` or current configured `model_reasoning_effort`.
- **Real Inspection**: If reasoning effort is absent from host configuration, reasoning capability reports `unknown` and supported effort values return `[]`.
- **Policy Mapping**:
  - `highest-supported`: maps to `xhigh` / `high` if evidenced, or highest supported value.
  - `lowest-sufficient` / `lowest-supported`: maps to `low` or lowest supported value.
  - `configured`: maps to current configured value.

## Subagent Mechanism (§25)
- **Evidence Detection**: Subagent capability is `available` only when `.codex/agents` directory exists, or subagents are configured/enabled in `config.toml`, or `CODEX_SUBAGENTS` is active.
- **Strict Unknown Semantics**: When unevidenced, subagent capability is reported as `unknown` and topology reports `supports_subagents: false`.
- **Configuration**: One TOML file per agent under `.codex/agents/<ticket_id>.toml` defining `name`, `model`, and `model_reasoning_effort`.

## Parallelism Mechanism
- **Concurrency Config**: `max_concurrency` in `config.toml` or `CODEX_MAX_CONCURRENCY` env variable.
- **Strict Unknown Semantics**: When concurrency is unconfirmed, parallelism reports `unknown` and topology reports `supports_parallel_execution: false`.

## Mutation Targets & Isolation
- Single-pass plan renders to `<workspace>/.codex/config.toml`.
- Decomposed plan renders main config plus separate agent configurations under `<workspace>/.codex/agents/<ticket_id>.toml`.
- Minimal TOML modifications preserving unrelated configuration keys.

## Apply Validation (§74)
For decomposed configuration, validation inspects effective host state and verifies:
1. `main model`: Verified against effective `model` in `config.toml`.
2. `main reasoning effort`: Verified against `model_reasoning_effort` in `config.toml`.
3. `worker model`: Verified against `model` in `.codex/agents/<ticket_id>.toml`.
4. `worker reasoning effort`: Verified against `model_reasoning_effort` in `.codex/agents/<ticket_id>.toml`.

## Known Unsupported Capabilities
- In-memory runtime session mutation without file persistence.

## Known Unknown Capabilities
- Model selection is `unknown` when no models are configured in TOML or runtime environment.
- Subagents and threads are `unknown` in bare unconfigured workspaces.
