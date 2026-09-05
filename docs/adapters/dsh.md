# DeepSeek Harness (DSH) Adapter Evidence Record

## Adapter ID
- **Adapter ID:** `dsh`

## Product / Harness Identity
- **Product Name:** DeepSeek Harness (DSH)
- **Harness ID:** `dsh`
- **Binary / Executable Names:**
  - CLI binary: `dsh` (installed via npm/npx/pnpm, e.g. `/Users/light/.nvm/versions/node/v24.19.0/bin/dsh`)
- **Underlying Architecture:**
  - Cordis microkernel runtime framework (`@deepseek-ai/cordis`, `cosmokit`, `schemastery`) with IoC plugin-composed capabilities and patch-layer architecture.
  - DeepSeek Harness boots a chosen profile (an ordered stack of plugin-bundle patch layers under user overrides) via `dsh [options] [command] [args...]` or `dsh --profile <name>`.
  - Plugins and bundles mount services onto Cordis Context (`ctx`), such as `ctx.llm`, `ctx.tools`, `ctx.agent`, `ctx.session`, `ctx.subagent`, `ctx.web`, `ctx.permission`.
- **Runtime Environment Markers:**
  - `DSH_RUNTIME` (`1` or `true`)
  - `DEEPSEEK_HARNESS` (`1` or `true`)
  - `CORDIS_APP` (application or container identifier)
  - `DSH_PLUGINS` (active runtime plugins, JSON array/object or comma-separated list)
  - `DSH_SERVICES` or `DSH_MOUNTED_SERVICES` (mounted services, e.g. `llm`, `models`, `subagents`, `mcp`, `sandboxes`, `tools`)
  - `DSH_SUBAGENT_PROVIDERS` (active subagent provider identifiers)
  - `DSH_SESSION_ID`, `DSH_AGENT`, `DSH_HOME`, `DSH_CONFIG`, `DSH_VERSION`, `DSH_PRESET`, `DSH_MODE`
  - Active process ancestry or process title matching `dsh`, `cordis`, or `deepseek-harness`

## Version Checked & Date Checked
- **Version Checked:** `0.1.1-rc.2` (`dsh --version`)
  - Peer runtime dependencies: `@deepseek-ai/cordis ^4.0.1`, `@deepseek-ai/schemastery ^3.18.1`, `@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app`, `@deepseek-ai/dsh-mcp-client`
- **Date Checked:** 2026-09-05

## Official Upstream, Documentation, & Config Schema Sources
- **Official Upstream:** DeepSeek AI (`git+https://github.com/deepseek-ai/deepseek-harness.git`)
- **Official Documentation:**
  - Built-in CLI help: `dsh --help`, `dsh --dump-config`, `dsh --dump-default-config`, `dsh plugin --help`
  - Cordis Microkernel specifications and patch overlay loader docs.
- **Official Config / Schema Source:**
  - DSH home root: `$DSH_HOME` (default `~/.dsh`)
  - Global user configuration: `$DSH_HOME/settings.yaml` (or `settings.yml`), `$DSH_HOME/.credentials.yaml`
  - Profiles directory: `$DSH_HOME/profiles/<profile-name>/`
    - Profile package: `package.json` declaring `dsh.profile.bundles` (e.g. `@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app`)
    - Profile patch layer: `$DSH_HOME/profiles/<name>/cordis.patch.yml` or `$DSH_HOME/cordis.patch.yml` (loader patch entries: id-targeted overrides, disables, and inserts)
    - Profile entry composition: `cordis.yml` / `cordis.yaml`
  - Workspace configuration:
    - Current canonical surface: `<workspace>/cordis.patch.yml` (explicit `--patch overlay`)
    - Legacy / compatibility-only fallback: `<workspace>/.dsh/config.json`, `<workspace>/dsh.config.json` (legacy read-only compatibility; NOT current configuration surfaces or mutation targets)

## Real Cordis Plugin Architecture vs Fabricated JSON Contracts
- **No Fabricated JSON Files:**
  - DSH does NOT use non-existent contracts such as `.dsh/subagents.json` or `.dsh/plugins.json` as native authoring formats.
  - Native DSH configuration uses Cordis YAML patch files (`cordis.patch.yml`, `cordis.yml`, `settings.yaml`).
  - DSH profile plugins are declared via patch entries:
    ```yaml
    - id: mcp-qwen-core
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: qwen_mm_core
        transport: stdio
        command: uvx
        args: [...]
    ```
  - For backward compatibility and cross-harness test reading, legacy JSON formats (`.dsh/config.json`, `dsh.config.json`) may be inspected, but current mutation targets strictly use Cordis YAML patch files.

## Executable Detection & Version Detection
- **Executable Detection:**
  - Active process check: `DSH_RUNTIME`, `DEEPSEEK_HARNESS`, `CORDIS_APP`, `DSH_PLUGINS`, `DSH_SERVICES`, `DSH_HOME`, `DSH_VERSION`, or process title/path matching `dsh` or `cordis`.
  - PATH lookup: `which dsh`.
  - Workspace markers: presence of `cordis.patch.yml`, `cordis.patch.yaml`, `cordis.yml`, `cordis.yaml`, `.dsh/`, `dsh.config.yml`, `dsh.config.yaml`, `dsh.yml`, `dsh.config.json`, or `.dsh/config.json`.
  - User markers: presence of `~/.dsh/`, `~/.config/dsh/`, or `~/.cordis/`.
- **Version Detection:**
  - Environment variable: `DSH_VERSION`, `DSH_PLUGIN_API_VERSION`.
  - CLI execution: `dsh --version` or `dsh -V` (emits e.g. `0.1.1-rc.2`).
  - File markers: `<workspace>/.dsh/version` or `~/.dsh/version`.
- **Compatibility Classification (§42):**
  - Semantic stable versions: `0.x`, `1.x`, `2.x` without preview/prerelease tags (`fail_closed_for_mutation: false`).
  - Developer-preview / prerelease tags: versions containing `rc`, `preview`, `dev`, `alpha`, `beta`, `canary` in `DSH_VERSION` or `DSH_PLUGIN_API_VERSION` classify as `partially-supported` with `fail_closed_for_mutation: true`.
  - Unevidenced or unversioned environments: `unknown-version` with `fail_closed_for_mutation: true`.
  - Explicit `"incompatible"`: `incompatible` with `fail_closed_for_mutation: true`.

## Config Files, Scopes, & Precedence
- **Host Config Files:**
  - Project Scope:
    - Current canonical mutation target: `<workspace>/cordis.patch.yml` (explicit `--patch overlay`)
    - Legacy read-only inspection: `<workspace>/.dsh/cordis.patch.yml`, `<workspace>/cordis.yml`, `<workspace>/.dsh/config.json`, `<workspace>/dsh.config.json`
  - User / Profile Scope:
    - Current canonical target: `$DSH_HOME/profiles/<name>/cordis.patch.yml` or `$DSH_HOME/cordis.patch.yml`
    - Global settings: `$DSH_HOME/settings.yaml`
    - Legacy inspection: `~/.dsh/config.json`
- **Config Hierarchy & Precedence:**
  - Runtime environment variables (`DSH_*`) take highest precedence.
  - Workspace configuration (`cordis.patch.yml`) overrides user / profile layer.
  - Profile patch layer (`cordis.patch.yml`) overrides bundle defaults.
  - User profile settings (`settings.yaml`) serve as fallback defaults.
- **Scope Isolation:**
  - Project preview and apply strictly target workspace configuration (`<workspace>/cordis.patch.yml`).
  - Global/user preview and apply target user/profile configuration (`$DSH_HOME/profiles/<name>/cordis.patch.yml` or `$DSH_HOME/cordis.patch.yml`).

## Model-Selection Mechanism
- **Host Mechanism:**
  - Default model defined in profile `agent-default-model` plugin configuration or `settings.yaml`:
    ```yaml
    agent-default-model:
      provider: easy-cliproxyapi
      model: gemini-3.8-flash-high
    ```
  - Providers configured in `llm-pi-ai` or `llm-deepseek` plugins in `settings.yaml` or Cordis config.
  - Machine-readable inspection: `dsh --dump-config` prints the composed profile tree showing all mounted plugins and configurations.
- **Adapter Adaptation:**
  - Reads models from `DSH_MODELS`, `DSH_MODEL`, `settings.yaml` (`llm-pi-ai.providers.*.models`, `agent-default-model.model`), or workspace Cordis/JSON configuration.
  - Returns empty list `[]` when no models are evidenced without guessing or inventing unevidenced models.
  - Capability reported as `available` only when models are explicitly evidenced.

## Reasoning / Effort / Variant Mechanism
- **Host Mechanism:**
  - Configured via `reasoning_effort` in agent preset configuration, `agent.cordis.yml`, or `DSH_REASONING_EFFORT`.
  - Evidenced values when configured: `low`, `medium`, `high`.
- **Adapter Adaptation:**
  - Native field: `reasoning_effort`.
  - Honest reporting: returns `supported_values = []` and `state = "unknown"` when unconfigured.
  - Resolves standard policies (`highest-supported`, `lowest-sufficient`, `configured`) against evidenced values.

## Agent / Subagent Mechanism (§40, §41)
- **Host Mechanism:**
  - Subagents in DSH Cordis architecture are composed via subagent provider plugins:
    - `@deepseek-ai/dsh-subagent` (core subagent service `ctx.subagent`)
    - `@deepseek-ai/dsh-subagent-spawn-in-process` (provider: `spawn` / `in-process`)
    - `@deepseek-ai/dsh-subagent-fork-in-process` (provider: `fork`)
    - Tool frontends: `@deepseek-ai/dsh-tool-subagent`, `@deepseek-ai/dsh-tool-subagent-control`, `@deepseek-ai/dsh-tool-subagent-report`
- **DSH Presence Rule (§40):**
  - DSH installation or presence alone does NOT mean subagents are available!
  - Subagent capability is `available` ONLY when active subagent provider plugins or environment variables (`DSH_SUBAGENT_PROVIDERS`) are explicitly evidenced.
  - In a standard DSH web profile where subagent tools are disabled, `subagents.state` reports `unavailable`.

## Parallelism & Concurrency Mechanism
- **Host Mechanism:**
  - Governed by concurrency settings in Cordis configuration or `DSH_MAX_CONCURRENCY`.
- **Adapter Adaptation:**
  - If concurrency > 1 is confirmed: `parallelism.state = "available"`, `supports_parallel_execution: true`.
  - If unconfirmed: `parallelism.state = "unknown"`, `supports_parallel_execution: false`.

## MCP Support & Companion Registration Mechanism (§41, §42, §43)
- **Host Mechanism:**
  - MCP client capability in DSH is provided by `@deepseek-ai/dsh-mcp-client` plugin mounted into Cordis.
  - Configuration format in Cordis patch files (`cordis.patch.yml`):
    ```yaml
    - insert:
        - id: mcp-agent-config
          name: '@deepseek-ai/dsh-mcp-client'
          config:
            serverName: agent-config
            transport: stdio
            command: agent-config
            args:
              - serve
    ```
  - Also compatible with structured JSON configurations:
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
- **Safety Lifecycle (§42):**
  - Developer-preview versions (`0.1.1-rc.2`, `alpha`, `beta`, `preview`, `dev`) and unconfirmed versions fail-closed for mutation while permitting read-only inspection.
  - Frozen previews with SHA-256 diff hashes prevent target drift between preview and apply.
  - Exact scope apply: project previews apply to workspace configuration; user previews apply to user profile configuration.
