# Cline Adapter Evidence Record (§24, §91)

## 1. Harness Identity
- **Adapter ID:** `cline`
- **Adapter Name:** Cline Adapter
- **Primary Binary / Process Names:** `cline`, `cline-agent`
- **Runtime Environment Markers:**
  - `CLINE_CLI` (`1` or `true`)
  - `CLINE_AGENT` (`1` or `true`)
  - `CLINE_SESSION`
  - `CLINE_SESSION_ID`
  - `CLINE_PROJECT_DIR`
  - `CLINE_CONFIG_DIR`
  - `CLINE_VERSION`
  - `CLINE_MODEL`
  - Active process ancestry or title containing `cline`

## 2. Supported Versions
- **Current Version Window:** `0.x`, `1.x`, `2.x` (supported, `fail_closed_for_mutation: false`)
- **Compatibility Classifications:**
  - `0.x`, `1.x`: `supported`
  - `2.x`: `partially-supported`
  - Non-versioned or unevidenced: `unknown-version` (`fail_closed_for_mutation: true`)
  - Explicit `"incompatible"`: `incompatible` (`fail_closed_for_mutation: true`)
- **Version Sources:**
  - CLI: `cline --version`
  - Environment: `CLINE_VERSION`, `CLINE_CLI_VERSION`
  - Workspace: `.cline/version`, `.cline/settings.json`
  - User: `~/.cline/version`

## 3. Evidence Sources
- Inspection derives strictly from authentic Cline configuration files, CLI probes, and runtime environment indicators.
- Strict unknown semantics: capabilities are never presumed available without explicit evidence.
- No model invention: returns models only when evidenced in configuration, modes, or environment.

## 4. Config Locations
- **Workspace Scope:**
  - `<workspace>/.cline/settings.json` (primary project settings)
  - `<workspace>/.cline/mcp.json` (project MCP servers)
  - `<workspace>/.cline/cline_mcp_settings.json` (alternative Cline MCP configuration)
  - `<workspace>/.clinerules` (Cline instructions and mode rules)
  - `<workspace>/.roomodes` (custom modes definition)
  - `<workspace>/.cline/agents/*.json` (agent definitions)
- **User Scope:**
  - `~/.cline/settings.json`
  - `~/.cline/mcp.json`
  - `~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`
  - `$CLINE_CONFIG_DIR/`

## 5. Config Precedence
1. Workspace configuration (`.cline/settings.json`, `.clinerules`) overrides user configuration.
2. User configuration (`~/.cline/settings.json`, VS Code globalStorage) supplies default fallback values.
3. Target mutation path selects `.cline/settings.json` for model/agent settings and `.cline/mcp.json` (or `.cline/cline_mcp_settings.json`) for MCP registrations.

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
  - Workspace scope: `<workspace>/.cline/mcp.json` or `.cline/cline_mcp_settings.json`
  - User scope: `~/.cline/mcp.json` or VS Code globalStorage `cline_mcp_settings.json`
- **Safe Lifecycle:** Full detect, preview (with unified diff and cryptographic hash), apply with hash verification, and read-back validation.

## 7. Model Mechanism
- **Model Keys:** `model`, `modelId`, `apiConfiguration.apiModelId` in `.cline/settings.json`, or `CLINE_MODEL` environment variable.
- **Typical Models:** `claude-3-7-sonnet-20250219`, `claude-3-5-sonnet-20241022`, `gpt-4o`.
- **Inventory Rule:** Returns `[]` when no models are configured or evidenced.

## 8. Reasoning Mechanism
- **Native Host Field:** `apiConfiguration.thinkingBudget` (or `reasoning_effort`)
- **Supported Values:** Evidenced effort values (e.g., `["low", "medium", "high"]`).
- **Honest Reporting:** Reports `unknown` with `[]` supported effort values when unevidenced.

## 9. Subagent Mechanism
- **Evidence:** Presence of `<workspace>/.cline/agents/`, `.clinerules`, `.roomodes`, or `customModes` in config.
- **State Reporting:** `subagents.state = "available"` when evidenced; `unknown` when unevidenced.
- **Parallel Execution:** Enabled only when concurrency limit is confirmed and > 1.
