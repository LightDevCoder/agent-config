# Kiro Adapter Evidence Record (§24, §37)

## 1. Harness Identity
- **Adapter ID:** `kiro`
- **Adapter Name:** Kiro Adapter
- **Primary Binary / Process Names:** `kiro`, `kiro-cli`, `kiro-ide`
- **Runtime Environment Markers:**
  - `KIRO_IDE` (`1` or `true`)
  - `KIRO_CLI` (`1` or `true`)
  - `KIRO_SESSION`
  - `KIRO_SESSION_ID`
  - `KIRO_AGENT`
  - `KIRO_HOME`
  - `KIRO_CONFIG_DIR`
  - `KIRO_VERSION`
  - Active process ancestry or title containing `kiro`
- **Unified Surface Mode:**
  - `ide`: When running inside Kiro IDE interface or `.kiro/ide` marker present
  - `cli`: When running inside Kiro CLI terminal session or `.kiro/cli` marker present
  - `unified`: Default unified configuration model where IDE and CLI share the underlying configuration

## 2. Supported Versions
- **Current Version Window:** `0.x` and `1.x` (supported, `fail_closed_for_mutation: false`)
- **Compatibility Classifications:**
  - `0.x`, `1.x`: `supported`
  - `2.x`: `partially-supported`
  - Non-versioned or unevidenced: `unknown-version` (`fail_closed_for_mutation: true`)
  - Explicit `"incompatible"`: `incompatible` (`fail_closed_for_mutation: true`)
- **Version Sources:**
  - Environment: `KIRO_VERSION`
  - Workspace: `.kiro/version`, `.kiro/config.json` (`version` field)
  - User: `~/.kiro/version`, `~/.config/kiro/version`

## 3. Evidence Sources
- Inspection derives exclusively from authentic file system configuration and runtime indicators.
- Strict unknown semantics: capabilities are never presumed available without explicit evidence.
- No model invention: returns models only when evidenced in repository configuration, user configuration, agent definitions, or environment.

## 4. Config Locations
- **Workspace Scope:**
  - `<workspace>/.kiro/config.json` (primary configuration)
  - `<workspace>/.kiro/settings.json` (alternative configuration)
  - `<workspace>/.kiro/mcp.json` (dedicated MCP configuration)
  - `<workspace>/kiro.json` (root configuration fallback)
  - `<workspace>/.kiro/agents/*.json` (agent definitions)
- **User Scope:**
  - `~/.kiro/config.json`
  - `~/.kiro/mcp.json`
  - `~/.config/kiro/config.json`
  - `~/.config/kiro/mcp.json`
  - `$KIRO_CONFIG_DIR/` or `$KIRO_HOME/`

## 5. Config Precedence
1. Workspace configuration (`.kiro/config.json`, `.kiro/settings.json`, `kiro.json`) overrides user configuration.
2. User configuration (`~/.kiro/config.json`, `~/.config/kiro/config.json`) supplies user defaults.
3. Target mutation path selects `.kiro/config.json` (or `.kiro/settings.json` / `kiro.json` if existing).

## 6. MCP Mechanism
- **Configuration Format:** JSON / JSONC with `mcpServers` object.
- **Server Entry Schema:**
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
- **Registration Scopes:**
  - Workspace scope: `<workspace>/.kiro/mcp.json` or `.kiro/config.json`
  - User scope: `~/.kiro/mcp.json`, `~/.kiro/config.json`, or `~/.config/kiro/mcp.json`
  - Agent scope: `<workspace>/.kiro/agents/<agent>.json`
- **Safe Lifecycle:** Full inspect, preview (with unified diff and cryptographic hash), apply with hash verification, and read-back validation.

## 7. Model Mechanism
- **Model Keys:** `model`, `default_model`, `supported_models`, or `models` array in config.
- **Typical Models:** `claude-3-7-sonnet`, `claude-3-5-haiku`, `gpt-4o`.
- **Per-Agent Model Control:** Supported via `agents.<agent_name>.model` in `.kiro/config.json` or individual `.kiro/agents/<agent>.json` definitions.
- **Inventory Rule:** Returns `[]` when no models are configured or evidenced.

## 8. Reasoning Mechanism
- **Native Host Field:** `reasoning_effort` (or `thinking`)
- **Honest Reporting:** If no effort values are configured or evidenced, reports `reasoning.state = "unknown"`, `supported_effort_values = []`, and `inspectReasoningOptions.supported_values = []`.

## 9. Subagent Mechanism
- **Evidence:** Presence of `<workspace>/.kiro/agents/` directory or non-empty `agents` object in `.kiro/config.json`.
- **State Reporting:** `subagents.state = "available"` when evidenced; `unknown` when unevidenced.
- **Per-Agent Model Control:** Supported when subagents are available.

## 10. Parallelism Mechanism
- Derived from `concurrency` or `max_concurrency` setting in configuration, or `KIRO_MAX_CONCURRENCY` environment variable.
- If concurrency limit is evidenced: `parallelism.state = "available"`, `supports_parallel_execution: true`.
- If unconfirmed: `parallelism.state = "unknown"`, `supports_parallel_execution: false`.

## 11. Mutation Targets
- Workspace configuration: `<workspace>/.kiro/config.json`
- Workspace companion MCP: `<workspace>/.kiro/config.json` or `<workspace>/.kiro/mcp.json`
- Agent definitions: `<workspace>/.kiro/agents/*.json` or embedded `agents` dictionary.

## 12. Known Unsupported Capabilities
- In-flight dynamic session hot-reloading for headless CLI mode (requires configuration reload on next invocation).

## 13. Known Unknown Capabilities
- Unspecified runtime cloud-routed models absent from local configuration or environment.
