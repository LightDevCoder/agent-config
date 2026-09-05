# Amp Adapter Evidence Record (§24, §91)

## 1. Harness Identity
- **Adapter ID:** `amp`
- **Adapter Name:** Amp Adapter
- **Primary Binary / Process Names:** `amp`, `amp-agent`, `amp-cli`
- **Runtime Environment Markers:**
  - `AMP_CLI` (`1` or `true`)
  - `AMP_AGENT` (`1` or `true`)
  - `AMP_SESSION`
  - `AMP_SESSION_ID`
  - `AMP_PROJECT_DIR`
  - `AMP_CONFIG_DIR`
  - `AMP_HOME`
  - `AMP_VERSION`
  - `AMP_MODEL`
  - Active process ancestry or title containing `amp`

## 2. Supported Versions
- **Current Version Window:** `0.x` and `1.x` (supported, `fail_closed_for_mutation: false`)
- **Compatibility Classifications:**
  - `0.x`, `1.x`: `supported`
  - `2.x`: `partially-supported`
  - Non-versioned or unevidenced: `unknown-version` (`fail_closed_for_mutation: true`)
  - Explicit `"incompatible"`: `incompatible` (`fail_closed_for_mutation: true`)
- **Version Sources:**
  - CLI: `amp --version`
  - Environment: `AMP_VERSION`, `AMP_CLI_VERSION`
  - Workspace: `.amp/version`, `.amp/settings.json`, `.amp/config.json`
  - User: `~/.amp/version`

## 3. Evidence Sources
- Inspection derives strictly from authentic Amp configuration files, CLI probes, and runtime environment indicators.
- Strict unknown semantics: capabilities are never presumed available without explicit evidence.
- No model invention: returns models only when evidenced in configuration, agent definitions, or environment.

## 4. Config Locations
- **Workspace Scope:**
  - `<workspace>/.amp/settings.json` (primary project settings)
  - `<workspace>/.amp/config.json` (alternative project configuration)
  - `<workspace>/.amp/mcp.json` (project MCP servers)
  - `<workspace>/amp.json` (root configuration fallback)
  - `<workspace>/.amp/agents/*.json` (agent definitions)
- **User Scope:**
  - `~/.amp/settings.json`
  - `~/.amp/config.json`
  - `~/.amp/mcp.json`
  - `~/.config/amp/settings.json`
  - `$AMP_CONFIG_DIR/` or `$AMP_HOME/`

## 5. Config Precedence
1. Workspace configuration (`.amp/settings.json`, `.amp/config.json`, `amp.json`) overrides user configuration.
2. User configuration (`~/.amp/settings.json`, `~/.config/amp/settings.json`) supplies default fallback values.
3. Target mutation path selects `.amp/settings.json` for model/agent settings and `.amp/mcp.json` for MCP companion registrations.

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
  - Workspace scope: `<workspace>/.amp/mcp.json` or `.amp/settings.json`
  - User scope: `~/.amp/mcp.json` or `~/.config/amp/mcp.json`
- **Safe Lifecycle:** Full detect, preview (with unified diff and cryptographic hash), apply with hash verification, and read-back validation.

## 7. Model Mechanism
- **Model Keys:** `model`, `default_model`, or `models` array in `.amp/settings.json` or `.amp/config.json`, or `AMP_MODEL` environment variable.
- **Typical Models:** `claude-3-7-sonnet`, `claude-3-5-sonnet`, `gpt-4o`.
- **Per-Agent Model Control:** Supported via `agents.<agent_id>.model` or `.amp/agents/<agent>.json`.
- **Inventory Rule:** Returns `[]` when no models are configured or evidenced.

## 8. Reasoning Mechanism
- **Native Host Field:** `reasoning_effort` (or `amp.reasoningEffort`)
- **Supported Values:** Evidenced effort values (e.g., `["low", "medium", "high"]`).
- **Honest Reporting:** Reports `unknown` with `[]` supported effort values when unevidenced.

## 9. Subagent Mechanism
- **Evidence:** Presence of `<workspace>/.amp/agents/` directory or `subagents: true` / `agents` in config.
- **State Reporting:** `subagents.state = "available"` when evidenced; `unknown` when unevidenced.
- **Parallel Execution:** Enabled only when concurrency limit is confirmed and > 1.
