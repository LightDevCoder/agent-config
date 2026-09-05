# GitHub Copilot CLI Adapter Evidence Record (§24, §34, §35)

## 1. Harness Identity
- **Adapter ID:** `copilot-cli`
- **Adapter Name:** GitHub Copilot CLI Adapter
- **Primary Binary / Process Names:** `copilot`, `gh-copilot`, `github-copilot-cli`
- **Runtime Environment Markers:**
  - `GITHUB_COPILOT_CLI` (`1` or `true`)
  - `COPILOT_CLI`
  - `GITHUB_COPILOT`
  - `COPILOT_SESSION_ID`
  - `COPILOT_AGENT`
  - `GH_COPILOT`
  - `COPILOT_CONFIG_DIR`
  - `COPILOT_HOME`
  - Active process ancestry or title containing `copilot` or `gh-copilot`

## 2. Supported Versions
- **Current Version Window:** `0.x` and `1.x` (supported, `fail_closed_for_mutation: false`)
- **Compatibility Classifications:**
  - `0.x`, `1.x`: `supported`
  - `2.x`: `partially-supported`
  - Non-versioned or unevidenced: `unknown-version` (`fail_closed_for_mutation: true`)
  - Explicit `"incompatible"`: `incompatible` (`fail_closed_for_mutation: true`)
- **Version Sources:**
  - Environment: `COPILOT_VERSION`, `GITHUB_COPILOT_VERSION`
  - Workspace: `.github/copilot/version`, `.copilot/version`
  - User: `~/.config/github-copilot/version`, `~/.copilot/version`

## 3. Evidence Sources
- Inspection derives solely from authentic file system configuration and runtime indicators.
- Custom agents are distinguished from simple prompt presets: only agents with isolated execution contexts or explicit agent properties are treated as subagents.
- No model invention; returns models only when evidenced in repository configuration, user configuration, agent definitions, or environment.

## 4. Config Locations
- **Repository Scope:**
  - `<workspace>/.github/copilot/config.json`
  - `<workspace>/.copilot/config.json`
  - `<workspace>/copilot.json`
  - `<workspace>/.github/copilot/mcp.json`
  - `<workspace>/.github/copilot/agents/*.json`
  - `<workspace>/.github/copilot-instructions.md` (prompt preset)
- **User Scope:**
  - `~/.config/github-copilot/config.json` (or `$XDG_CONFIG_HOME/github-copilot/config.json`)
  - `~/.copilot/config.json`
  - `~/.config/github-copilot/mcp.json`
  - `~/.config/github-copilot/agents/*.json`
  - `$COPILOT_CONFIG_DIR/` or `$COPILOT_HOME/`

## 5. Config Precedence
1. Repository configuration (`.github/copilot/config.json`, `.copilot/config.json`, `copilot.json`) overrides user configuration.
2. User configuration (`~/.config/github-copilot/config.json`, `~/.copilot/config.json`) supplies user defaults.
3. Target mutation path selects `.github/copilot/config.json` (or `.copilot/config.json` if existing).

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
  - Repo scope: `<workspace>/.github/copilot/mcp.json` or `.copilot/mcp.json`
  - User scope: `~/.config/github-copilot/mcp.json` or `~/.copilot/mcp.json`
- **Safe Lifecycle:** Full detect, preview (with unified diff and cryptographic hash), apply with hash verification, and read-back validation.

## 7. Model Mechanism
- **Model Keys:** `model`, `default_model`, or `models` array in config.
- **Typical Models:** `gpt-4o`, `gpt-4o-mini`, `claude-3.7-sonnet`, `o3-mini`.
- **Per-Agent Model Control:** Supported via `model` property in agent JSON definitions (`.github/copilot/agents/*.json`).
- **Inventory Rule:** Returns `[]` when no models are configured or evidenced.

## 8. Reasoning Mechanism
- **Native Host Field:** `reasoning_effort`
- **Values:** e.g. `"low"`, `"medium"`, `"high"`.
- **Honest Reporting:** If unconfigured in config or environment (`COPILOT_REASONING_EFFORT`), reports `reasoning.state = "unknown"`, `supported_effort_values = []`, and `inspectReasoningOptions.supported_values = []`.

## 9. Subagent Mechanism & Prompt Preset Distinction (§34)
- **Distinction from Prompt Presets:**
  - **Prompt Presets:** Template/instruction files like `copilot-instructions.md` or JSON definitions that only supply `prompt` / `template` strings without execution context isolation, tools, or model selection.
  - **Custom Agents / Subagents:** Definitions specifying isolated worker execution contexts (`context: "isolated"` or `context: "isolated-worker"` or `isolated: true`), dedicated `model`, tools, or MCP servers.
- **File Format:** JSON files in `.github/copilot/agents/*.json`:
  ```json
  {
    "name": "worker-task-1",
    "description": "Isolated worker agent",
    "model": "gpt-4o-mini",
    "context": "isolated-worker",
    "isolated": true
  }
  ```
- **Capability State:** Available when isolated agent definitions or directory exists; unknown otherwise.

## 10. Parallelism Mechanism
- Derived strictly from `concurrency`, `max_concurrency`, `parallel_workers` in configuration, or `COPILOT_MAX_CONCURRENCY` environment variable.
- Parallel execution is marked supported only when concurrency limit is confirmed > 1.

## 11. Mutation Targets
- `<workspace>/.github/copilot/config.json`: updates model, reasoning effort.
- `<workspace>/.github/copilot/mcp.json`: registers `agent-config` companion MCP server.
- `<workspace>/.github/copilot/agents/<ticket_id>.json`: creates isolated worker custom agent configurations.

## 12. Known Unsupported Capabilities
- Real-time interactive session model switching during an active streaming prompt execution without starting a new session or delegating to a subagent.

## 13. Known Unknown Capabilities
- Dynamic remote GitHub Enterprise copilot policy restrictions and model enablement flags when operating offline or disconnected from GitHub API.
