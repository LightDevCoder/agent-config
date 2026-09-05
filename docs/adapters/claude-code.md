# Claude Code Adapter Evidence Record

## Adapter ID
- **Adapter ID:** `claude-code`

## Product / Harness Identity
- **Product Name:** Claude Code (`claude-code`)
- **Harness ID:** `claude-code`
- **Binary / Executable Names:** `claude`, `claude-code` (e.g. `/Users/light/.local/bin/claude`)
- **Runtime Environment Markers:**
  - `CLAUDE_CODE` (`1` or `true`)
  - `CLAUDE_CODE_ENTRY`
  - `CLAUDE_PROJECT_DIR`
  - `CLAUDE_SESSION_ID`
  - `CLAUDE_CONFIG_DIR`
  - `CLAUDE_AUTO_COMPACT`
  - Active process title or binary basename matching `claude`

## Version Checked & Date Checked
- **Version Checked:** `2.1.226 (Claude Code)` (installed on local host via `/Users/light/.local/bin/claude`)
- **Date Checked:** 2026-09-05

## Official Upstream, Documentation, & Config Schema Sources
- **Official Upstream:** Anthropic Claude Code (`claude`)
- **Official Documentation:** Built-in CLI help (`claude --help`, `claude mcp --help`, `claude mcp add --help`, `claude mcp list --help`, `claude doctor --help`, `claude agents --help`)
- **Official Config/Schema Source:** JSON / JSONC settings hierarchy:
  - Global user configuration: `~/.claude/settings.json`, `~/.claude.json`, `$CLAUDE_CONFIG_DIR/`
  - Project configuration: `<workspace>/.claude/settings.json`, `<workspace>/.claude.json`
  - Project MCP configuration: `<workspace>/.mcp.json` (canonical `claude mcp add --scope project`)
  - User MCP configuration: `~/.claude.json` (canonical `claude mcp add --scope user`)
  - Custom agent definitions: `<workspace>/.claude/agents/*.md`, `~/.claude/agents/*.md`

## Executable Detection & Version Detection
- **Executable Detection:**
  - Active process check: `CLAUDE_CODE`, `CLAUDE_PROJECT_DIR`, `CLAUDE_SESSION_ID`, or process title/path.
  - PATH lookup: `which claude` or `which claude-code`.
  - Workspace markers: presence of `.claude/`, `.claude.json`, `.claude/settings.json`, `.claude/agents/`, or `.mcp.json`.
  - User markers: presence of `~/.claude/`, `~/.claude.json`, or `$CLAUDE_CONFIG_DIR`.
- **Version Detection:**
  - Environment variables: `CLAUDE_VERSION`, `CLAUDE_CODE_VERSION`.
  - CLI execution: `claude --version` or `claude -v` (emits e.g. `2.1.226 (Claude Code)`).
  - File markers: `<workspace>/.claude/version`, `~/.claude/version`.
- **Compatibility Classification:**
  - `0.x`, `1.x`, `2.x`: `supported` (`fail_closed_for_mutation: false`)
  - Non-versioned or unevidenced: `unknown-version` (`fail_closed_for_mutation: true`)
  - Explicit `"incompatible"`: `incompatible` (`fail_closed_for_mutation: true`)

## Config Files, Scopes, & Precedence
- **Host Config Files & Scopes:**
  - User Scope: `~/.claude/settings.json`, `~/.claude.json` (stores user preferences, credentials, and user-scoped `mcpServers`), `~/.claude/agents/*.md`.
  - Project Scope: `<workspace>/.claude/settings.json` (primary project settings), `<workspace>/.claude.json` (alternative project configuration), `<workspace>/.claude/agents/*.md` (project subagents), `<workspace>/.mcp.json` (project MCP servers).
  - Local Scope: `<workspace>/.claude/settings.local.json`, user-local project settings in `~/.claude.json` under `projects[<cwd>]`.
- **Config Hierarchy & Precedence:**
  1. Project configuration (`.claude/settings.json`, `.claude.json`) overrides user configuration (`~/.claude/settings.json`, `~/.claude.json`).
  2. Setting sources can be selectively loaded via `--setting-sources <sources>` (`user`, `project`, `local`).
  3. Managed / enterprise settings (`managed-mcp.json`, policy settings) take ultimate precedence if configured by host.
- **Scope Isolation:**
  - Project preview and apply strictly mutate project files (`.claude/settings.json`, `.claude/agents/*.md`, project MCP target).
  - User preview and apply strictly mutate user configuration files.

## Model-Selection Mechanism
- **Host Mechanism:**
  - Selected via CLI flag `--model <model>` (e.g. `claude --model sonnet` or full model ID `claude-3-7-sonnet-20250219`).
  - Configured in settings JSON via `"model": "..."` key (or `"fallback-model"`).
  - Custom agents define model via YAML frontmatter `model: "..."` in `.claude/agents/<agent>.md`.
- **Adapter Adaptation:**
  - Enumerates models evidenced in project settings, user settings, custom agent frontmatters, or runtime environment variables (`CLAUDE_MODEL`).
  - Strict reporting: if no models are configured or evidenced, returns empty inventory `[]` (never fabricates default models).

## Reasoning / Effort / Variant Mechanism
- **Host Mechanism:**
  - Native CLI flag: `--effort <level>` with evidenced choices: `low`, `medium`, `high`, `xhigh`, `max`.
  - Native configuration settings: `"thinking"` or `"effort"` in settings JSON.
    - Extended thinking: `thinking: { "type": "enabled", "budget_tokens": 4096 }` or `thinking: { "supported_values": ["low", "medium", "high", "xhigh", "max"] }`.
    - Session effort level: `"effort": "high"`.
- **Adapter Adaptation:**
  - Native fields: `thinking` (or `effort`).
  - Honest reporting: if neither `thinking` nor `effort` is configured, reports reasoning capability `state = "unknown"` and supported effort values as `[]`. Does not synthesize fake effort arrays.
  - Policy mapping:
    - `"highest-supported"`: resolves to highest evidenced value (e.g. `"max"`, `"xhigh"`, or `"high"`).
    - `"lowest-sufficient"` / `"lowest-supported"`: resolves to lowest evidenced value (e.g. `"low"`).
    - `"configured"`: resolves to default or current value.

## Agent / Subagent Mechanism, Workers, & Parallelism
- **Host Mechanism:**
  - Custom agents defined as Markdown files with YAML frontmatter located in `.claude/agents/*.md` (both workspace project scope and user `~/.claude/agents/` scope).
  - Each agent markdown file defines:
    ```markdown
    ---
    name: "worker-agent"
    model: "claude-3-5-haiku-20241022"
    description: "Delegated worker"
    ---
    System prompt and instructions.
    ```
  - Dispatched via CLI: `claude --agent <agent>` or managed via `claude agents` command.
  - Concurrency configured via `concurrency` or `max_concurrency` setting in configuration, or `CLAUDE_MAX_CONCURRENCY` env.
- **Adapter Adaptation:**
  - Presence of `.claude/agents/` directory or custom agent files evidences `subagents.state = "available"`.
  - In absence of agent directory or files, reports `unknown`.
  - Decomposed execution plans render isolated per-work-item files under `.claude/agents/<ticket_id>.md`.
  - Parallelism is `available` only when concurrency > 1 is confirmed. Otherwise reports `unknown`.

## MCP Support, Registration Mechanism, Scopes, & Doctor/Status
- **Host Mechanism:**
  - Native CLI management: `claude mcp add --scope <local|user|project> <name> <commandOrUrl> [args...]`, `claude mcp add-json`, `claude mcp list`, `claude mcp get <name>`, `claude mcp remove`.
  - Formats and targets:
    - Project scope: `.mcp.json` at project root using `{"mcpServers": { ... }}` (conforming to `claude mcp add --scope project`).
    - User scope: `~/.claude.json` using `{"mcpServers": { ... }}` (conforming to `claude mcp add --scope user`).
    - Local scope: `~/.claude.json` under `projects[<cwd>].mcpServers`.
  - Health/doctor: `claude mcp list` health-checks approved servers; `claude doctor` validates installation and settings files.
- **Adapter Adaptation:**
  - In project scope, targets canonical `.mcp.json` at workspace root (fallback inspection checks legacy targets).
  - Previews produce exact unified diffs with cryptographic baseline hash and preview hash (`FrozenMutationPreview`).
  - Apply strictly preserves scope without re-deriving targets.

## Machine-Readable Inspection Surfaces
- Settings files: `.claude/settings.json`, `.claude.json`, `.claude.local.json`, `~/.claude.json`.
- MCP targets: `.mcp.json` (canonical project), `~/.claude.json` (canonical user).
- Agents directory: `.claude/agents/*.md`, `~/.claude/agents/*.md`.
- CLI commands: `claude --version`, `claude mcp list`, `claude doctor`, `claude agents --json`.

## Writable Configuration Targets & Protected Configuration
- **Writable Targets:**
  - Project Scope: `<workspace>/.claude/settings.json`, `<workspace>/.claude/agents/<ticket_id>.md`, `<workspace>/.mcp.json`.
  - User Scope: `~/.claude/settings.json`, `~/.claude.json`.
- **Protected / Managed Configuration:**
  - Preserves unrelated user/project settings (`allowedTools`, `theme`, `permissions`, `projects`, etc.) via JSONC edit preserving comments and structure.
  - Preserves existing custom agents in `.claude/agents/` not managed by current plan.

## Known Available, Unavailable, & Unknown Capabilities
- **Available Capabilities (when evidenced):**
  - Project and user settings configuration.
  - Custom agent definitions via `.claude/agents/*.md` with per-agent model frontmatter.
  - MCP registration across project and user scopes.
  - Headless/programmatic execution via `claude -p / --print`.
- **Unavailable Capabilities:**
  - In-memory session mutation without restarting CLI session or starting a new session.
  - Unstructured/non-JSON configuration files (Claude Code expects JSONC and Markdown frontmatter).
- **Unknown Capabilities:**
  - Cloud token quotas, remote control connection endpoints, and dynamic rate limits in unmetered interactive CLI sessions without host telemetry.

## Mutation Strategy & Validation Strategy
- **Mutation Strategy:**
  - Strict 2-phase lifecycle: `previewCompanionRegistration` / `previewConfiguration` generate frozen previews with exact targets, baseline hashes, and unified diffs.
  - `applyCompanionRegistration` and `applyConfiguration` consume exact approved previews and fail closed on hash mismatch.
  - JSON editing uses non-destructive parser (`jsonc-parser`) preserving formatting and comments.
- **Validation Strategy:**
  - Semantic verification on post-apply state:
    1. Effective `model` in settings matches expected controller model.
    2. Effective `thinking` / `effort` matches expected controller reasoning effort.
    3. Each worker markdown file in `.claude/agents/<ticket_id>.md` is parsed for YAML frontmatter `model` and validated.
    4. MCP server entry is verified in the effective registration target.

