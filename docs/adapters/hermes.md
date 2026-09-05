# Hermes Adapter Evidence Record (§10, §49, §50, §51)

## 1. Adapter ID & Harness Identity
- **Adapter ID**: `hermes`
- **Product / Harness Identity**: Hermes Agent / Nous Hermes CLI (`hermes` executable)
- **Harness ID**: `hermes`
- **Binary / Executable Names**: `hermes` (e.g. `/Users/light/.local/bin/hermes` or `~/.hermes/hermes-agent/venv/bin/hermes`)
- **Runtime Environment Markers**:
  - `HERMES_HOME`: Directory pointing to user/profile home (default `~/.hermes`)
  - `HERMES_PROFILE`: Active profile name (e.g. `default`, `niney`)
  - `HERMES_CONFIG`: Configuration file path override
  - `HERMES_ENV`: Environment secrets file path override
  - `HERMES_INFERENCE_MODEL`: Active inference model override
  - `HERMES_SESSION` or `HERMES_SESSION_ID`: Active session ID
  - Active process title or binary basename matching `hermes`

## 2. Version Checked & Date Checked
- **Version Checked**: `Hermes Agent v0.21.0 (2026.8.31) · upstream 79445a49`
  - Python: `3.11.16`
  - OpenAI SDK: `2.24.0`
- **Date Checked**: 2026-09-05
- **Compatibility Classification**:
  - `0.x`: `supported` (`fail_closed_for_mutation: false`)
  - `1.x`: `partially-supported` (`fail_closed_for_mutation: false`)
  - Explicit `"incompatible"`: `incompatible` (`fail_closed_for_mutation: true`)
  - Unevidenced or unversioned: `unknown-version` (`fail_closed_for_mutation: true`)

## 3. Official Upstream, Documentation, & Config Schema Sources
- **Official Upstream**: Nous Research Hermes Agent (`hermes-agent`)
- **Official Documentation**:
  - Built-in CLI help surfaces:
    - `hermes --help`
    - `hermes doctor`
    - `hermes config --help` (`show`, `edit`, `get`, `set`, `unset`, `path`, `env-path`, `check`, `migrate`)
    - `hermes profile --help` (`list`, `use`, `create`, `delete`, `describe`, `show`, `alias`, `rename`, `export`, `import`, `install`, `update`, `info`)
    - `hermes mcp --help` (`serve`, `add`, `remove`, `list`, `test`, `configure`, `login`, `reauth`, `picker`, `catalog`, `install`)
    - `hermes tools --help` (`list`, `disable`, `enable`, `post-setup`)
    - `hermes model --help`
- **Official Config/Schema Source**:
  - YAML configuration schema read from `config.yaml` located under `$HERMES_HOME` (default `~/.hermes/config.yaml` or `~/.hermes/profiles/<name>/config.yaml`).
  - Environment secrets file: `.env` under `$HERMES_HOME`.
  - Project configuration: `<workspace>/.hermes/config.yaml`.
  - Config version: tracked via `_config_version` (currently `v40`).

## 4. Executable Detection & Version Detection
- **Executable Detection**:
  - Active runtime context: `HERMES_HOME`, `HERMES_PROFILE`, `HERMES_CONFIG`, `HERMES_SESSION`, `HERMES_SESSION_ID`, `HERMES_INFERENCE_MODEL`.
  - PATH lookup: `which hermes`.
  - Workspace markers: `<workspace>/.hermes/`, `<workspace>/.hermes/config.yaml`.
  - User markers: `$HERMES_HOME/`, `~/.hermes/`, `~/.hermes/config.yaml`.
- **Version Detection**:
  1. Priority 1: CLI execution `hermes -V` or `hermes --version` (emits e.g. `Hermes Agent v0.21.0 (2026.8.31) · upstream 79445a49`).
  2. Priority 2: Process environment variable `HERMES_VERSION`.
  3. Priority 3: File markers `<workspace>/.hermes/version` or `$HERMES_HOME/version`.

## 5. Config Files, Scopes, & Precedence
- **Config Locations**:
  - Project Scope: `<workspace>/.hermes/config.yaml`
  - User / Profile Scope: `$HERMES_HOME/config.yaml` (default `~/.hermes/config.yaml` or `~/.hermes/profiles/<name>/config.yaml`)
- **Precedence Order**:
  CLI flags (`-m`, `--provider`, `--reasoning`, `-t`, `-s`) > Project configuration (`<workspace>/.hermes/config.yaml`) > Active profile configuration (`$HERMES_HOME/config.yaml`)
- **Scope Isolation & Mutation Safety**:
  - Project preview / apply strictly targets `<workspace>/.hermes/config.yaml`.
  - User preview / apply strictly targets `$HERMES_HOME/config.yaml`.
  - Apply never spills to the wrong scope or flattens profiles.

## 6. Provider & Model Selection Mechanism (SPEC §50)
Hermes is **not** a trivial model switcher. It operates with a rich multi-layered model and provider architecture:
- **Active Model & Provider**:
  Configured in `config.yaml` under `model`:
  ```yaml
  model:
    default: gemini-3.8-flash-high
    provider: custom:cpa-gui
    base_url: http://127.0.0.1:8317/v1
    aliases:
      local: omlx/Qwen3.8-9B-mlx-4Bit
  ```
- **Configured Model Resources**:
  - `providers`: Built-in and custom inference providers (e.g. `omlx`, `openrouter`, `openai-codex`, `anthropic`).
  - `custom_providers`: Custom endpoint definitions detailing endpoint URLs and available model maps:
    ```yaml
    custom_providers:
      - name: cpa-gui
        api_mode: chat_completions
        base_url: http://127.0.0.1:8317/v1
        model: gemini-3.8-flash-high
        models:
          claude-sonnet-4-6: {}
          gemini-3.8-flash-high: {}
          gpt-5.5: {}
    ```
  - `moa`: Mixture of Agents configuration detailing reference models and aggregator model.
  - `delegation`: Subagent worker model and provider (`delegation.model`, `delegation.provider`).
  - `fallback`: Fallback provider chain tried when the primary model fails.
- **CLI Commands**:
  - `hermes model`: Interactive model and provider picker.
  - `hermes config get model`: Emits active model mapping.
  - `hermes config set model <value>`: Sets model configuration.
  - Command-line overrides: `hermes -m <MODEL> --provider <PROVIDER>`.

## 7. Reasoning / Effort / Variant Mechanism
- **Native Field**: `agent.reasoning_effort` in `config.yaml` (overridable per invocation via `--reasoning <LEVEL>`).
- **Supported Effort Levels**:
  `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`.
- **Per-Model Overrides**: `agent.reasoning_overrides.<model_id>`.
- **Policy Mapping**:
  - `highest-supported`: maps to `ultra` > `max` > `xhigh` > `high`.
  - `lowest-sufficient` / `lowest-supported`: maps to `minimal` > `low`.
  - `configured`: maps to current configured `agent.reasoning_effort`.

## 8. Agent / Subagent Mechanism, Delegation, & Multi-Agent
- **Subagents & Delegation**:
  - Configured under `delegation` in `config.yaml`:
    ```yaml
    delegation:
      model: omlx/Qwen3.8-9B-mlx-4Bit
      provider: omlx
      max_iterations: 250
    ```
  - Subagent concurrency governed by `delegation.max_concurrent_children` and `delegation.max_spawn_depth`.
  - Background execution units and worker dispatch.
- **Git Worktree Isolation**:
  - Flag `-w, --worktree` spawns sessions in isolated git worktrees for parallel agents.
- **Multi-Profile Collaboration**:
  - `hermes profile`: Multiple isolated Hermes instances with their own configurations, databases, and memory.
  - `hermes kanban`: Multi-profile collaboration board managing tasks across profiles.
  - `hermes peer`: Bot-to-bot messaging across peer gateways.

## 9. Tools, Toolsets, & Skills
- **Platform Toolsets**: Configured in `config.yaml` under `platform_toolsets` (e.g. `cli`, `telegram`, `discord`).
- **Tool Management**:
  - `hermes tools list`: Shows tool availability and status.
  - Toolsets: `browser-use`, `clarify`, `code_execution`, `computer_use`, `cronjob`, `delegation`, `desktop_ui`, `file`, `memory`, `project`, `session_search`, `skills`, `terminal`, `todo`, `tts`, `video`, `vision`, `web search`, `web extract`.
- **Skills**:
  - Repository-local skills: `<workspace>/.hermes/skills/`, `<workspace>/.agents/skills/`.
  - User skills: `$HERMES_HOME/skills/`.
  - Configured external skill directories: `skills.external_dirs` in `config.yaml`.
  - Preloaded via CLI flag `-s, --skills <SKILLS>`.

## 10. MCP Support & Companion Registration (§49, §50)
- **Configuration Format**:
  Stored in `config.yaml` under `mcp_servers`:
  ```yaml
  mcp_servers:
    agent-config:
      command: agent-config
      args:
        - serve
      enabled: true
  ```
- **CLI Commands**:
  - `hermes mcp list`: Lists configured MCP servers.
  - `hermes mcp add <name> --command <cmd> --args <args>`: Registers stdio MCP server.
  - `hermes mcp remove <name>`: Removes an MCP server.
  - `hermes mcp test <name>`: Tests MCP server connection.
  - `hermes mcp serve`: Exposes Hermes conversations over MCP.
- **Scopes & Targets**:
  - Project scope: `<workspace>/.hermes/config.yaml`
  - User scope: `$HERMES_HOME/config.yaml`
- **Companion Setup Lifecycle**:
  1. Inspect existing MCP servers via `config.yaml` reading or `hermes mcp list`.
  2. Determine target file strictly respecting scope (`project` vs `user`/`global`).
  3. Preview configuration patch with YAML diff and SHA-256 hash.
  4. Require explicit approval (preview hash verification).
  5. Apply: prioritize `hermes mcp add` CLI command or atomic YAML file update.
  6. Validate registration via read-back.

## 11. Known Capabilities Matrix
- **Available**:
  - Subagents and delegation (`supports_subagents: true`, `supports_multi_agent: true`)
  - Concurrency and parallelism (when delegation / worktrees enabled)
  - Full multi-provider model selection
  - Reasoning effort configuration (`agent.reasoning_effort`)
  - Toolsets and Skills integration
  - MCP companion registration
- **Unavailable**:
  - In-memory ephemeral configuration without disk persistence
- **Unknown**:
  - Capabilities when running in unconfigured or unevidenced environments
