# Windsurf / Cascade Adapter Evidence Record (§24, §91)

## 1. Harness Identity
- **Adapter ID:** `windsurf`
- **Adapter Name:** Windsurf Adapter
- **Primary Binary / Process Names:** `windsurf`, `cascade`, `codeium`
- **Runtime Environment Markers:**
  - `WINDSURF_CLI` (`1` or `true`)
  - `WINDSURF_AGENT` (`1` or `true`)
  - `CASCADE_AGENT` (`1` or `true`)
  - `WINDSURF_SESSION`
  - `WINDSURF_SESSION_ID`
  - `CASCADE_SESSION_ID`
  - `WINDSURF_PROJECT_DIR`
  - `WINDSURF_CONFIG_DIR`
  - `WINDSURF_VERSION`
  - `CASCADE_VERSION`
  - `WINDSURF_MODEL`
  - `CASCADE_MODEL`
  - Active process ancestry or title containing `windsurf` or `cascade`

## 2. Supported Versions
- **Current Version Window:** `0.x` and `1.x` (supported, `fail_closed_for_mutation: false`)
- **Compatibility Classifications:**
  - `0.x`, `1.x`: `supported`
  - `2.x`: `partially-supported`
  - Non-versioned or unevidenced: `unknown-version` (`fail_closed_for_mutation: true`)
  - Explicit `"incompatible"`: `incompatible` (`fail_closed_for_mutation: true`)
- **Version Sources:**
  - CLI: `windsurf --version`
  - Environment: `WINDSURF_VERSION`, `CASCADE_VERSION`, `WINDSURF_CLI_VERSION`
  - Workspace: `.windsurf/version`, `.codeium/windsurf/version`, `.windsurf/settings.json`
  - User: `~/.codeium/windsurf/version`, `~/.windsurf/version`

## 3. Evidence Sources
- Inspection derives strictly from authentic Codeium/Windsurf configuration files, CLI probes, and runtime environment indicators.
- Strict unknown semantics: capabilities are never presumed available without explicit evidence.
- No model invention: returns models only when evidenced in configuration or environment.

## 4. Config Locations
- **Workspace Scope:**
  - `<workspace>/.windsurf/settings.json` (primary project settings)
  - `<workspace>/.codeium/windsurf/settings.json` (Codeium Windsurf settings)
  - `<workspace>/.codeium/windsurf/mcp_config.json` (Codeium Windsurf MCP configuration)
  - `<workspace>/.windsurf/mcp.json` (Windsurf MCP servers)
  - `<workspace>/.windsurfrules` (Cascade agent rules)
  - `<workspace>/.windsurf/agents/*.json` (agent definitions)
- **User Scope:**
  - `~/.codeium/windsurf/mcp_config.json`
  - `~/.codeium/windsurf/settings.json`
  - `~/.windsurf/settings.json`
  - `~/.windsurf/mcp.json`
  - `~/.config/Windsurf/User/settings.json`
  - `$WINDSURF_CONFIG_DIR/`

## 5. Config Precedence
1. Workspace configuration (`.windsurf/settings.json`, `.codeium/windsurf/settings.json`) overrides user configuration.
2. User configuration (`~/.codeium/windsurf/settings.json`, `~/.windsurf/settings.json`) supplies default fallback values.
3. Target mutation path selects `.windsurf/settings.json` for model/agent settings and `.codeium/windsurf/mcp_config.json` (or `.windsurf/mcp.json`) for MCP registrations.

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
- **Registration Scopes:**
  - Workspace scope: `<workspace>/.codeium/windsurf/mcp_config.json` or `.windsurf/mcp.json`
  - User scope: `~/.codeium/windsurf/mcp_config.json` or `~/.windsurf/mcp.json`
- **Safe Lifecycle:** Full detect, preview (with unified diff and cryptographic hash), apply with hash verification, and read-back validation.

## 7. Model Mechanism
- **Model Keys:** `cascade.model`, `windsurf.model`, `model`, or `models` in `.windsurf/settings.json`, or `CASCADE_MODEL` / `WINDSURF_MODEL` environment variables.
- **Typical Models:** `claude-3-7-sonnet`, `claude-3-5-sonnet`, `gpt-4o`.
- **Inventory Rule:** Returns `[]` when no models are configured or evidenced.

## 8. Reasoning Mechanism
- **Native Host Field:** `cascade.reasoningEffort` (or `windsurf.reasoningEffort`, `reasoning_effort`)
- **Supported Values:** Evidenced effort values (e.g., `["low", "medium", "high"]`).
- **Honest Reporting:** Reports `unknown` with `[]` supported effort values when unevidenced.

## 9. Subagent Mechanism
- **Evidence:** Presence of `<workspace>/.windsurf/agents/` directory or `cascade.subagents: true` in config.
- **State Reporting:** `subagents.state = "available"` when evidenced; `unknown` when unevidenced.
- **Parallel Execution:** Enabled only when concurrency limit is confirmed and > 1.
