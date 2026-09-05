# OpenCode Adapter Evidence Record (§24)

## Harness Identity
- **Harness ID**: `opencode`
- **Adapter ID**: `opencode`
- **Name**: OpenCode Adapter
- **Runtime Process / Indicators**:
  - `process.env.OPENCODE_SESSION_ID`
  - `process.env.OPENCODE`
  - `process.env.OPENCODE_CONFIG`
  - `process.env.OPENCODE_CONFIG_DIR`
  - Executable name or title containing `opencode`

## Supported Versions (§21, §22)
- **Supported**: `0.x`, `1.x`
- **Partially Supported**: `2.x` (monitored for breaking schema changes)
- **Fail-Closed for Mutation**: Unknown versions or `incompatible` versions allow read-only inspection but fail-closed for configuration mutation.

## Evidence Sources
1. **Runtime Context**: `OPENCODE_SESSION_ID`, `OPENCODE_CONFIG_DIR`, process title.
2. **Project Workspace**:
   - `opencode.jsonc` (project root)
   - `opencode.json` (project root)
   - `.opencode/opencode.jsonc` (workspace hidden)
   - `.opencode/opencode.json` (workspace hidden)
   - `.opencode/version` (workspace version stamp)
3. **User / Global Configuration**:
   - `$OPENCODE_CONFIG_DIR/opencode.jsonc` or `opencode.json`
   - `~/.config/opencode/opencode.jsonc` or `opencode.json`
   - `~/.config/opencode/version`

## Config Locations & Hierarchy
- **Global Layer**: `~/.config/opencode/opencode.json[c]` (or `$OPENCODE_CONFIG_DIR/opencode.json[c]`).
- **Workspace Layer (Hidden)**: `<workspace>/.opencode/opencode.json[c]`.
- **Workspace Layer (Root)**: `<workspace>/opencode.json[c]`.

## Config Precedence (§30)
- **Precedence Order** (highest to lowest):
  1. Workspace Root: `opencode.jsonc` / `opencode.json`
  2. Workspace Directory: `.opencode/opencode.jsonc` / `.opencode/opencode.json`
  3. Global: `~/.config/opencode/opencode.jsonc` / `opencode.json`
- **Override Semantics**:
  - **Primitive Fields**: Project `model`, `variant`, `max_concurrency`, `theme` override global values directly.
  - **Provider & Model Layering**: Provider dictionaries merge across layers. However, when a model is redefined in a higher layer, its settings (specifically `variants`) completely override the lower layer's definition.
    - *Example*: If global defines `openai/gpt-4o` with `variants = ["low"]` and project defines `openai/gpt-4o` with `variants = ["high"]`, the effective variant is `["high"]` (NOT unioned or flattened).
  - **Agents**: Per-agent entries in `agent.<name>` at project level override global definitions.
  - **MCP**: `mcp.servers` entries merge, with project definitions overriding global definitions by server name.

## MCP Mechanism
- **Configuration Path**: Embedded in `opencode.json[c]` under `mcp.servers.<name>` (or legacy `mcp.<name>`).
- **Format**:
  ```jsonc
  {
    "mcp": {
      "servers": {
        "agent-config": {
          "command": "agent-config",
          "args": ["serve"]
        }
      }
    }
  }
  ```
- **Scopes**: Supports workspace project level (default) and global level (`scope: "global"`).
- **Preservation**: JSONC modifications preserve comments and formatting via `jsonc-parser`.

## Model Mechanism
- **Selected Model**: Top-level `model` property in `opencode.json[c]`.
- **Catalog**: Defined in `provider.<provider_name>.models.<model_name>` or `providers.<provider_name>.models`.
- **Model ID Format**: `<provider>/<model>` (e.g. `anthropic/claude-3-7-sonnet`, `openai/gpt-4o`).

## Reasoning Mechanism (§32)
- **Native Field**: `variant`.
- **Discovery**: Derived strictly from evidenced `variants` on models in `provider` or top-level `variant` in effective config.
- **Strict Unknown Semantics**: When no variants are evidenced in host configuration, reasoning capability reports `unknown` and effort values return `[]`. No default effort arrays or fallback to `high` are synthesized.
- **Policy Mapping**:
  - `highest-supported`: maps to `max` if present, else highest discrete variant.
  - `lowest-sufficient` / `lowest-supported`: maps to lowest discrete variant.
  - Concrete variant string: validated against model-supported variants.

## Subagent Mechanism
- **Configuration**: `agent.<ticket_id>` dictionary in `opencode.json[c]`.
- **Properties**:
  - `model`: Model assigned to the subagent.
  - `variant`: Model-specific reasoning/execution variant.

## Parallelism Mechanism
- **Concurrency Config**: `max_concurrency` or `concurrency` in `opencode.json[c]` or `OPENCODE_MAX_CONCURRENCY` env variable.
- **Unknown Semantics**: Concurrency is reported as `unknown` when not evidenced in config or environment. Parallelism capability reflects concurrency state.

## Mutation Targets & Isolation (§31)
- **Inspection**: Reads layered effective state across all configuration tiers.
- **Mutation**: Writes ONLY to the designated layer (default: project root `opencode.json[c]` or `opencode.json`).
- **No Flattening**: Inherited global configurations (such as global providers or themes) are NEVER copied or flattened into the project configuration.
- **JSONC Fidelity**: `jsonc-parser` (`jsonc.modify` and `jsonc.applyEdits`) ensures comments, formatting, and trailing commas are preserved.
- **Fail-Closed Parsing**: If a target configuration has syntax errors, mutations are rejected immediately to prevent configuration corruption.

## Apply Validation (§75)
After configuration is applied, validation inspects effective host state and validates:
1. `main model`: Effective `model` matches expected execution model.
2. `main variant`: Effective `variant` matches expected resolved variant.
3. `worker model`: For each decomposed work item, `agent.<id>.model` matches expected worker model.
4. `worker variant`: For each decomposed work item with specified effort/policy, `agent.<id>.variant` matches expected worker variant.

## Known Unsupported Capabilities
- Dynamic runtime session mutation without file persistence (`supports_session_mutation: false`).

## Known Unknown Capabilities
- Concurrency limit is `unknown` when `max_concurrency` is not explicitly declared.
- Reasoning capability is `unknown` when models have no explicit `variants` defined.
