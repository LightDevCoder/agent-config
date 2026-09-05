# DeepSeek Harness (DSH) Adapter Evidence Record (§24, §39, §40, §41, §42, §43)

## 1. Harness Identity
- **Adapter ID:** `dsh`
- **Adapter Name:** DeepSeek Harness Adapter
- **Underlying Architecture:** Cordis microkernel runtime with IoC plugin-composed capabilities (not a static JSON-config CLI).
- **Runtime Environment Markers:**
  - `DSH_RUNTIME` (`1` or `true`)
  - `DEEPSEEK_HARNESS` (`1` or `true`)
  - `CORDIS_APP` (application or container identifier)
  - `DSH_PLUGINS` (active runtime plugins, JSON array/object or comma-separated list)
  - `DSH_SERVICES` or `DSH_MOUNTED_SERVICES` (mounted services, e.g. `models`, `subagents`, `mcp`, `sandboxes`)
  - `DSH_SUBAGENT_PROVIDERS` (active subagent provider identifiers)
  - `DSH_SESSION_ID`, `DSH_AGENT`, `DSH_HOME`, `DSH_CONFIG`, `DSH_VERSION`
  - Active process ancestry or process title matching `dsh`, `cordis`, or `deepseek-harness`

## 2. Supported Versions (§42)
- **Current Version Window:** `0.x`, `1.x`, `2.x` stable (supported, `fail_closed_for_mutation: false`).
- **Compatibility Classifications:**
  - Semantic stable releases (`0.x`, `1.x`, `2.x` without preview tags): `supported`
  - Developer-preview / unstable builds containing `preview`, `dev`, `alpha`, `beta`, `canary`, or `rc` in `version` or `pluginApiVersion`: `partially-supported` with `fail_closed_for_mutation: true`.
  - Non-versioned or unevidenced environments: `unknown-version` with `fail_closed_for_mutation: true`.
  - Explicit incompatible markers: `incompatible` with `fail_closed_for_mutation: true`.
- **Version Sources:**
  - Environment: `DSH_VERSION`, `DSH_PLUGIN_API_VERSION`
  - Workspace: `<workspace>/.dsh/version`, `<workspace>/dsh.config.json` (`version` and `pluginApiVersion` fields)
  - User: `~/.dsh/version`

## 3. Evidence Sources
- Capabilities are derived exclusively from active runtime plugins, mounted services, and authentic configuration.
- **Strict Unknown Semantics:** Unconfirmed capabilities remain `unknown` or `unavailable`.
- **No Presumed Subagents (§40):** DSH presence alone never implies subagents are available; active subagent provider plugins must be explicitly verified.
- **No Model Invention:** Returns models only when evidenced in runtime environment, active LLM plugins, or configuration.

## 4. Config Locations
- **Workspace Scope:**
  - `<workspace>/dsh.config.json` (canonical workspace configuration)
  - `<workspace>/.dsh/config.json` (alternative directory-scoped configuration)
  - `<workspace>/.dsh/plugins.json` (active plugins and service mounts)
  - `<workspace>/dsh.config.ts`, `dsh.config.js`, `dsh.config.yaml`, `dsh.yml`, `cordis.yml` (host identification markers)
- **User Scope:**
  - `~/.dsh/`
  - `~/.config/dsh/`
  - `~/.cordis/`
  - `~/.dsh.json`

## 5. Config Precedence
1. Process environment variables (`DSH_*`) override file configurations.
2. Workspace configuration (`dsh.config.json` or `.dsh/config.json`) takes precedence over user-level configurations.
3. Target mutation path selects `<workspace>/.dsh/config.json` if existing, otherwise `<workspace>/dsh.config.json`.

## 6. MCP Mechanism (§43)
- **Plugin Delivery:** MCP client capability in DSH is provided via Cordis plugins (e.g. `@dsh/plugin-mcp`, `mcp`, `mcp-client`).
- **Server Entry Schema:**
  ```json
  {
    "plugins": {
      "@dsh/plugin-mcp": {
        "mcpServers": {
          "agent-config": {
            "command": "agent-config",
            "args": ["serve"]
          }
        }
      }
    }
  }
  ```
- **Lifecycle Integration:**
  - `inspectCompanionRegistration`: Checks for active/configured MCP plugin AND the presence of `agent-config` in `mcpServers`.
  - `previewCompanionRegistration`: Renders diff and cryptographic sha256 hash. Enforces fail-closed mutation safety on preview/unsupported versions (§42).
  - `applyCompanionRegistration`: Validates preview hash before committing file edits.
  - `validateCompanionRegistration`: Reads back and confirms reachability through active MCP plugin.

## 7. Model Mechanism
- **Model Sources:**
  - `DSH_MODELS`, `DSH_MODEL`
  - `@dsh/plugin-llm` or `@dsh/plugin-deepseek` plugin configuration (`model`, `models`)
  - Root `model` or `models` in `dsh.config.json`
- **Typical Models:** `deepseek-chat`, `deepseek-reasoner`.
- **Inventory Rule:** Returns empty array `[]` when no models are evidenced.

## 8. Reasoning Mechanism
- **Native Host Field:** `reasoning_effort`
- **Supported Values:** Derived from `DSH_REASONING_EFFORT`, configuration `reasoning_effort`, `supported_reasoning_efforts`, or LLM plugin settings.
- **Honest Reporting:** In an unconfigured workspace, unsupported/unconfirmed reasoning reports `reasoning.state = "unknown"` and `supported_effort_values = []`.

## 9. Subagent Mechanism (§41)
- **Architecture Seam:** Subagents are an optional capability seam composed of modular provider plugins.
- **Supported Providers:**
  - `in-process`: Local in-memory task workers
  - `fork`: Child process workers
  - `acp`: Agent Client Protocol external agents
  - `codex`: Codex harness subagents
  - `claude-code`: Claude Code subagents
  - `dsh-sdk`: DeepSeek Harness SDK subagents
- **Active State Rule:** `subagents.state` is reported as `"available"` ONLY when active provider plugins or environment declarations are evidenced. If DSH is present without subagent plugins, it reports `"unavailable"`.

## 10. Parallelism Mechanism
- Derived from `concurrency` or `max_concurrency` setting in configuration or `DSH_MAX_CONCURRENCY`.
- If concurrency > 1 is confirmed: `parallelism.state = "available"`, `supports_parallel_execution: true`.
- If unconfirmed: `parallelism.state = "unknown"`, `supports_parallel_execution: false`.

## 11. Mutation Targets
- Primary workspace config: `<workspace>/dsh.config.json` or `<workspace>/.dsh/config.json`.
- Fail-closed behavior: Developer-preview and unknown versions reject mutations while permitting read-only inspection.

## 12. Known Unsupported Capabilities
- Direct runtime kernel code hot-swapping without configuration write-back.
- Dynamic developer-preview plugin API mutation without verified semantic stability.

## 13. Known Unknown Capabilities
- Dynamic remote cloud model routing where models are not registered in local plugins or environment.
