# Cursor Adapter Evidence Record (§24, §36)

## 1. Harness Identity
- **Adapter ID:** `cursor`
- **Adapter Name:** Cursor Adapter
- **Primary Binary / Process Names:** `cursor`, `cursor-agent`
- **Runtime Environment Markers:**
  - `CURSOR_CLI` (`1` or `true`)
  - `CURSOR_AGENT` (`1` or `true`)
  - `CURSOR_SESSION_ID`
  - `CURSOR_PROJECT_DIR`
  - `CURSOR_CONFIG_DIR`
  - Active process ancestry or title containing `cursor`

## 2. Supported Versions
- **Current Version Window:** `0.x` and `1.x` (supported, `fail_closed_for_mutation: false`)
- **Compatibility Classifications:**
  - Standard semver: `supported`
  - Non-versioned or unevidenced: `unknown-version` (`fail_closed_for_mutation: true`)
  - Explicit `"incompatible"`: `incompatible` (`fail_closed_for_mutation: true`)
- **Version Sources:**
  - CLI: `cursor --version`
  - Environment: `CURSOR_VERSION`, `CURSOR_CLI_VERSION`
  - Workspace: `.cursor/version`
  - User: `~/.cursor/version`

## 3. Evidence Sources
- Inspection derives from authentic Cursor configuration files, host CLI commands, and runtime environment indicators.
- MCP status inspection strictly prioritizes host CLI inspection command (`cursor mcp list --json`) when available, falling back to raw config file parsing.
- Models and capabilities are only reported when genuinely evidenced in settings or environment.

## 4. Config Locations
- **Project Scope:**
  - `<workspace>/.cursor/settings.json` (primary project settings)
  - `<workspace>/.cursor/mcp.json` (project MCP servers)
  - `<workspace>/.cursorrules`
- **User Scope:**
  - `~/.cursor/settings.json`
  - `~/.cursor/mcp.json`
  - `~/.config/Cursor/User/settings.json`
  - `$CURSOR_CONFIG_DIR/`

## 5. Config Precedence
1. Workspace project configuration (`.cursor/settings.json`, `.cursor/mcp.json`) overrides user configuration.
2. User configuration (`~/.cursor/settings.json`, `~/.cursor/mcp.json`) serves as fallback defaults.
3. Target mutation paths select `<workspace>/.cursor/settings.json` for model/agent settings and `<workspace>/.cursor/mcp.json` for MCP companion registrations.

## 6. MCP Mechanism
- **Configuration Format:** JSON / JSONC with top-level `mcpServers` object.
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
- **CLI Command Prioritization:** Cursor adapter attempts `cursor mcp list --json` first before inspecting config files.
- **Registration Scopes:**
  - Project scope: `<workspace>/.cursor/mcp.json`
  - Global scope: `~/.cursor/mcp.json`
- **Safe Lifecycle:** Full detect, preview (with unified diff and cryptographic hash), apply with hash verification, and read-back validation.

## 7. Model Mechanism
- **Model Keys:** `cursor.model`, `cursor.models`, or `model` in `.cursor/settings.json`, or `CURSOR_MODEL` environment variable.
- **Typical Models:** `claude-3-7-sonnet`, `claude-3-5-sonnet`, `gpt-4o`, `cursor-small`.
- **Inventory Rule:** Returns `[]` when no models are configured or evidenced.

## 8. Reasoning Mechanism
- **Native Host Field:** `cursor.reasoningEffort` (or `cursor.reasoning`, `cursor.thinking`)
- **Supported Values:** `low`, `medium`, `high` when evidenced.
- **Honest Reporting:** Reports `unknown` with `[]` supported effort values when unevidenced.

## 9. Subagent Mechanism
- **Capability Evidence:**
  - If background/parallel agents are enabled in settings (`cursor.parallelAgents: true` or `cursor.composer.parallelAgents: true`), reports `available`.
  - Otherwise reports `unknown` honestly.
- **Per-Agent Model Control:** Supported when parallel agents are enabled.

## 10. Parallelism Mechanism
- Derived from `cursor.parallelAgents` and `cursor.maxConcurrency` in settings.
- When enabled: `parallelism.state = "available"`, `supports_parallel_execution: true`.
- When unconfirmed: `parallelism.state = "unknown"`, `supports_parallel_execution: false`.

## 11. Mutation Targets
- `<workspace>/.cursor/settings.json`: updates model and reasoning effort.
- `<workspace>/.cursor/mcp.json`: adds `agent-config` companion MCP server.

## 12. Known Unsupported Capabilities
- Dynamic mid-generation model switching during streaming response.
- In-memory agent state modification without updating configuration files.

## 13. Known Unknown Capabilities
- Proprietary Cursor indexing and code graph caching policies unexposed via CLI commands.
