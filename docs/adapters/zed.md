# Zed Adapter Evidence Record (§24, §38)

## 1. Harness Identity
- **Adapter ID:** `zed`
- **Adapter Name:** Zed Adapter
- **Host Class:** Editor-class Agent Host (different architecture and execution models from traditional CLI harnesses)
- **Primary Binary / Process Names:** `zed`, `zed-editor`, `cli`
- **Runtime Environment Markers:**
  - `ZED_AGENT`
  - `ZED_APP`
  - `ZED_WINDOW_ID`
  - `ZED_PID`
  - `ZED_TERM`
  - `ZED_PATH`
  - `ZED_SESSION_ID`
  - `ZED_HOME`
  - `ZED_VERSION`
  - Active process ancestry or title containing `zed`

## 2. Agent Execution Paths Distinction (§38)
Zed distinguishes three distinct agent execution paths:
1. **Zed native Agent (`zed-agent`):** Internal editor agent operating within the Zed Assistant panel (default path).
2. **External Agent over ACP (`external-acp`):** External agent communicating via the Agent Client Protocol (ACP) for Anthropic / OpenAI integrations.
3. **Terminal Thread (`terminal-thread`):** Agent session executing inside Zed's embedded terminal threads.

The adapter explicitly queries and declares which agent path is being configured via `getAgentPath()`, recording it in capabilities, preview metadata, and validation results.

## 3. Supported Versions
- **Current Version Window:** `0.x` and `1.x` (supported, `fail_closed_for_mutation: false`)
- **Compatibility Classifications:**
  - `0.x`, `1.x`: `supported`
  - `2.x`: `partially-supported`
  - Non-versioned or unevidenced: `unknown-version` (`fail_closed_for_mutation: true`)
  - Explicit `"incompatible"`: `incompatible` (`fail_closed_for_mutation: true`)
- **Version Sources:**
  - Environment: `ZED_VERSION`
  - Workspace: `.zed/version`, `.zed/settings.json` (`version` field)
  - User: `~/.config/zed/version`, `~/Library/Application Support/Zed/version`

## 4. Evidence Sources
- Inspection derives strictly from authentic Zed settings (`settings.json`) and runtime indicators.
- No model invention: inspects `assistant.default_model`, `assistant.profiles`, and `language_models` provider tables without synthesizing unevidenced models.
- Strict unknown semantics: unconfirmed subagent or parallelism capabilities report `unknown`.

## 5. Config Locations
- **Workspace Scope:**
  - `<workspace>/.zed/settings.json` (primary workspace settings)
  - `<workspace>/.zed/tasks.json`
  - `<workspace>/.zed/keymap.json`
- **User Scope:**
  - `~/.config/zed/settings.json` (Linux / standard Unix)
  - `~/Library/Application Support/Zed/settings.json` (macOS standard)
  - `$ZED_HOME/settings.json`

## 6. Config Precedence
1. Workspace settings (`.zed/settings.json`) override user settings.
2. User settings (`~/.config/zed/settings.json` or macOS equivalent) supply user defaults.
3. Target mutation path selects `<workspace>/.zed/settings.json`.

## 7. MCP Mechanism: Context Servers
- **Configuration Format:** JSON / JSONC with `context_servers` dictionary in `settings.json`.
- **Server Entry Schema:**
  ```json
  {
    "context_servers": {
      "agent-config": {
        "command": "agent-config",
        "args": ["serve"]
      }
    }
  }
  ```
- **Registration Scopes:**
  - Workspace scope: `<workspace>/.zed/settings.json` (`context_servers`)
  - User scope: `~/.config/zed/settings.json` (`context_servers`)
- **Safe Lifecycle:** Full inspect, preview (unified diff and cryptographic hash), apply with hash verification, and read-back validation.

## 8. Model Mechanism
- **Configuration Keys:**
  - `assistant.default_model`: Can be structured `{ "provider": "zed.dev", "model": "claude-3-7-sonnet" }` or string model identifier.
  - `assistant.profiles`: Map of profile name to profile configuration including `model`.
  - `language_models`: Provider definitions (e.g. `openai`, `anthropic`, `ollama`) containing `available_models`.
- **Inventory Rule:** Returns `[]` when no models are configured or evidenced.

## 9. Reasoning Mechanism
- **Native Host Field:** `assistant.reasoning_effort` or `reasoning_effort`.
- **Honest Reporting:** If unevidenced, reports `reasoning.state = "unknown"`, `supported_effort_values = []`, and `inspectReasoningOptions.supported_values = []`.

## 10. Subagent & Agent Profiles Mechanism
- **Evidence:** Presence of `assistant.profiles` with profile definitions in `settings.json`.
- **State Reporting:** `subagents.state = "available"` when profiles are defined; `unknown` when absent.
- **Per-Agent Model Control:** Supported via profile-specific `model` fields in `assistant.profiles`.

## 11. Parallelism Mechanism
- Derived from `assistant.concurrency`, `max_concurrency` setting in `settings.json`, or `ZED_MAX_CONCURRENCY` environment variable.
- If concurrency limit is evidenced: `parallelism.state = "available"`, `supports_parallel_execution: true`.
- If unconfirmed: `parallelism.state = "unknown"`, `supports_parallel_execution: false`.

## 12. Mutation Targets
- Workspace settings: `<workspace>/.zed/settings.json`
- Companion MCP target: `context_servers` in `<workspace>/.zed/settings.json`

## 13. Known Unsupported Capabilities
- CLI-only stdin streaming flags that do not apply to editor-embedded GUI agent threads.

## 14. Known Unknown Capabilities
- Dynamic remote language models fetched at runtime through Zed cloud account authentication without local configuration declaration.
