# Gemini CLI Adapter Evidence Record (§24, §33)

## 1. Harness Identity
- **Adapter ID:** `gemini-cli`
- **Adapter Name:** Gemini CLI Adapter
- **Primary Binary / Process Names:** `gemini`, `gemini-cli`
- **Runtime Environment Markers:**
  - `GEMINI_CLI` (`1` or `true`)
  - `GEMINI_PROJECT_DIR`
  - `GEMINI_SESSION_ID`
  - `GEMINI_CONFIG_DIR`
  - `GEMINI_HOME`
  - `GEMINI_API_KEY` / `GOOGLE_API_KEY`
  - Active process ancestry or title containing `gemini`

## 2. Supported Versions
- **Current Version Window:** `0.x`, `1.x`, `2.x` (supported, `fail_closed_for_mutation: false`)
- **Compatibility Classifications:**
  - `0.x`, `1.x`, `2.x`: `supported`
  - Major > 2: `partially-supported`
  - Non-versioned or unevidenced: `unknown-version` (`fail_closed_for_mutation: true`)
  - Explicit `"incompatible"`: `incompatible` (`fail_closed_for_mutation: true`)
- **Version Sources:**
  - Environment: `GEMINI_CLI_VERSION`, `GEMINI_VERSION`
  - Workspace: `.gemini/version`
  - User: `~/.gemini/version`, `~/.config/gemini/version`
  - CLI: `gemini --version`

## 3. Evidence Sources
- Inspection derives solely from authentic file system configuration and runtime indicators.
- No model invention; returns models only when evidenced in repository configuration, user configuration, or environment.
- Subagents and per-worker model controls are strictly recognized as unavailable per Gemini CLI architecture (single-session CLI tool).

## 4. Config Locations
- **Project Scope:**
  - `<workspace>/.gemini/config.json` (primary project settings)
  - `<workspace>/.gemini/settings.json`
  - `<workspace>/gemini.json`
  - `<workspace>/.gemini/mcp.json`
- **User Scope:**
  - `~/.gemini/config.json`
  - `~/.config/gemini/config.json`
  - `~/.gemini/settings.json`
  - `~/.gemini/mcp.json`
  - `$GEMINI_CONFIG_DIR/` or `$GEMINI_HOME/`

## 5. Config Precedence
1. Workspace project configuration (`.gemini/config.json`, `.gemini/settings.json`, `gemini.json`) overrides user configuration.
2. User configuration (`~/.gemini/config.json`, `~/.config/gemini/config.json`) serves as fallback defaults.
3. Target mutation path selects `.gemini/config.json` in workspace root.

## 6. MCP Mechanism
- **Configuration Format:** JSON / JSONC with nested `mcp.servers` object (or top-level `mcpServers`).
- **Server Entry Schema:**
  ```json
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
- **Registration Scopes:**
  - Project scope: `<workspace>/.gemini/config.json` or `.gemini/mcp.json`
  - User scope: `~/.gemini/config.json` or `~/.config/gemini/config.json`
- **Safe Lifecycle:** Full detect, preview (with unified diff and cryptographic hash), apply with hash verification, and read-back validation.

## 7. Model Mechanism
- **Model Keys:** `model`, `fallback_model`, `available_models`, `models` in config, or `GEMINI_MODEL` environment variable.
- **Typical Models:** `gemini-2.0-flash`, `gemini-2.0-pro`, `gemini-1.5-pro`, `gemini-1.5-flash`.
- **Inventory Rule:** Returns `[]` when no models are configured or evidenced.

## 8. Reasoning Mechanism
- **Native Host Field:** `reasoning_effort` (or `thinking_budget`, `thinking`)
- **Supported Values:** `low`, `medium`, `high` when evidenced.
- **Honest Reporting:** Reports `unavailable` with `[]` supported effort values when no thinking/reasoning configuration is present.

## 9. Subagent Mechanism
- **Status:** `unavailable`
- **Architectural Reality:** Gemini CLI runs single-session CLI workflows and does not provide native child agent spawning or agent orchestration.
- **Per-Agent Model Control:** `unavailable`.

## 10. Parallelism Mechanism
- **Status:** `unavailable`
- Gemini CLI operates strictly with `max_concurrency: 1`. Parallel worker execution is unsupported.

## 11. Mutation Targets
- `<workspace>/.gemini/config.json`: updates model, reasoning effort, and MCP server registrations.

## 12. Known Unsupported Capabilities
- Native child agent orchestration or subagent spawning.
- Per-worker isolated model assignments.
- Parallel worker execution loops.

## 13. Known Unknown Capabilities
- Dynamic cloud token quotas and rate limit concurrency bounds when running against remote Google Cloud Vertex AI or Google AI Studio endpoints.
