# Roo Code Adapter Evidence Record (§24, §91)

## 1. Harness Identity
- **Adapter ID:** `roo-code`
- **Adapter Name:** Roo Code Adapter
- **Primary Binary / Process Names:** `roo-code`, `roocode`, `roo-agent`
- **Runtime Environment Markers:**
  - `ROO_CODE_CLI` (`1` or `true`)
  - `ROO_AGENT` (`1` or `true`)
  - `ROO_SESSION`
  - `ROO_SESSION_ID`
  - `ROO_PROJECT_DIR`
  - `ROO_CONFIG_DIR`
  - `ROO_VERSION`
  - `ROO_CODE_VERSION`
  - `ROO_MODEL`
  - Active process ancestry or title containing `roo-code` or `roocode`

## 2. Supported Versions
- **Current Version Window:** `0.x`, `1.x`, `2.x`, `3.x` (supported, `fail_closed_for_mutation: false`)
- **Compatibility Classifications:**
  - `0.x`, `1.x`: `supported`
  - `2.x`, `3.x`: `partially-supported`
  - Non-versioned or unevidenced: `unknown-version` (`fail_closed_for_mutation: true`)
  - Explicit `"incompatible"`: `incompatible` (`fail_closed_for_mutation: true`)
- **Version Sources:**
  - CLI: `roo-code --version`
  - Environment: `ROO_VERSION`, `ROO_CODE_VERSION`, `ROO_CLI_VERSION`
  - Workspace: `.roo/version`, `.roo/settings.json`
  - User: `~/.roo/version`

## 3. Evidence Sources
- Inspection derives strictly from authentic Roo Code configuration files, CLI probes, and runtime environment indicators.
- Strict unknown semantics: capabilities are never presumed available without explicit evidence.
- No model invention: returns models only when evidenced in configuration, `.roomodes`, or environment.

## 4. Config Locations
- **Workspace Scope:**
  - `<workspace>/.roo/settings.json` (primary project settings)
  - `<workspace>/.roomodes` (custom modes definition)
  - `<workspace>/.roo/mcp.json` (project MCP servers)
  - `<workspace>/.roo/roo_mcp_settings.json` (Roo MCP configuration)
  - `<workspace>/.roocode/mcp.json` (alternative MCP configuration)
  - `<workspace>/.roo/agents/*.json` (agent definitions)
- **User Scope:**
  - `~/.roo/settings.json`
  - `~/.roo/mcp.json`
  - `~/.config/Code/User/globalStorage/rooveterinaryinc.roo-cline/settings/cline_mcp_settings.json`
  - `$ROO_CONFIG_DIR/`

## 5. Config Precedence
1. Workspace configuration (`.roo/settings.json`, `.roomodes`) overrides user configuration.
2. User configuration (`~/.roo/settings.json`, VS Code globalStorage) supplies default fallback values.
3. Target mutation path selects `.roo/settings.json` for model/agent settings and `.roo/mcp.json` (or `.roo/roo_mcp_settings.json`) for MCP registrations.

## 6. MCP Mechanism
- **Configuration Format:** JSON / JSONC with top-level `mcpServers` object.
- **Server Entry Schema:**
  ```json
  {
    "mcpServers": {
      "agent-config": {
        "command": "agent-config",
        "args": ["serve"],
        "disabled": false,
        "autoApprove": []
      }
    }
  }
  ```
- **Registration Scopes:**
  - Workspace scope: `<workspace>/.roo/mcp.json` or `.roo/roo_mcp_settings.json`
  - User scope: `~/.roo/mcp.json` or VS Code globalStorage `cline_mcp_settings.json`
- **Safe Lifecycle:** Full detect, preview (with unified diff and cryptographic hash), apply with hash verification, and read-back validation.

## 7. Model Mechanism
- **Model Keys:** `model`, `modelId`, `apiConfiguration.apiModelId` in `.roo/settings.json`, modes in `.roomodes`, or `ROO_MODEL` environment variable.
- **Typical Models:** `claude-3-7-sonnet`, `claude-3-5-sonnet`, `gpt-4o`.
- **Inventory Rule:** Returns `[]` when no models are configured or evidenced.

## 8. Reasoning Mechanism
- **Native Host Field:** `apiConfiguration.thinkingBudget` (or `reasoning_effort`)
- **Supported Values:** Evidenced effort values (e.g., `["low", "medium", "high"]`).
- **Honest Reporting:** Reports `unknown` with `[]` supported effort values when unevidenced.

## 9. Subagent Mechanism
- **Evidence:** Presence of `<workspace>/.roomodes`, `<workspace>/.roo/agents/`, or `customModes` in config.
- **State Reporting:** `subagents.state = "available"` when evidenced; `unknown` when unevidenced.
- **Parallel Execution:** Enabled only when concurrency limit is confirmed and > 1.
