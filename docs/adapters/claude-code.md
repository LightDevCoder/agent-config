# Claude Code Adapter Evidence Record (§24, §27, §28)

## 1. Harness Identity
- **Adapter ID:** `claude-code`
- **Adapter Name:** Claude Code Adapter
- **Primary Binary / Process Names:** `claude`, `claude-code`
- **Runtime Environment Markers:**
  - `CLAUDE_CODE` (`1` or `true`)
  - `CLAUDE_CODE_ENTRY`
  - `CLAUDE_PROJECT_DIR`
  - `CLAUDE_SESSION_ID`
  - `CLAUDE_CONFIG_DIR`
  - `CLAUDE_AUTO_COMPACT`
  - Active process ancestry or title containing `claude`

## 2. Supported Versions
- **Current Version Window:** `0.x` and `1.x` (supported, `fail_closed_for_mutation: false`)
- **Compatibility Classifications:**
  - `0.x`, `1.x`: `supported`
  - `2.x`: `partially-supported`
  - Non-versioned or unevidenced: `unknown-version` (`fail_closed_for_mutation: true`)
  - Explicit `"incompatible"`: `incompatible` (`fail_closed_for_mutation: true`)
- **Version Sources:**
  - Environment: `CLAUDE_VERSION`, `CLAUDE_CODE_VERSION`
  - Workspace: `.claude/version`, `.claude.json` (`version` field)
  - User: `~/.claude/version`, `~/.claude.json` (`version` field)

## 3. Evidence Sources
- Inspection strictly uses host configuration files and active process/environment evidence.
- No invented model inventories; models must be evidenced in project settings, user settings, custom agent frontmatters, or runtime environment.
- No synthesized effort levels; reasoning effort is derived solely from evidenced `thinking` or `reasoning_effort` configurations.

## 4. Config Locations
- **Project Scope:**
  - `<workspace>/.claude/settings.json` (primary project settings)
  - `<workspace>/.claude.json` (alternative project configuration)
  - `<workspace>/.claude/config.json`
  - `<workspace>/.claude/mcp.json` (project MCP servers)
  - `<workspace>/.claude/agents/*.md` (project subagent definitions)
- **User Scope:**
  - `~/.claude/settings.json`
  - `~/.claude.json` (user profile and configuration)
  - `~/.claude/mcp.json`
  - `~/.claude/agents/*.md`
  - `$CLAUDE_CONFIG_DIR/` (overrides default `~/.claude`)

## 5. Config Precedence
1. Workspace project configuration (`.claude/settings.json`, `.claude.json`) overrides user configuration.
2. User configuration (`~/.claude.json`, `~/.claude/settings.json`) serves as fallback defaults.
3. Target mutation path selects existing project configuration files first (`.claude/settings.json` then `.claude.json`), defaulting to `.claude/settings.json`.

## 6. MCP Mechanism
- **Configuration Format:** JSON / JSONC with `mcpServers` dictionary.
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
  - Project scope: `<workspace>/.claude/mcp.json` or `.claude.json`
  - User scope: `~/.claude/mcp.json` or `~/.claude.json`
- **Safe Mutation:** Previews generate unified diffs; apply requires cryptographic hash match; syntax errors fail closed.

## 7. Model Mechanism
- **Model Key:** `model` string, optional `models` list in configuration.
- **Typical Models:** `claude-3-7-sonnet-20250219`, `claude-3-5-sonnet-20241022`, `claude-3-5-haiku-20241022`, or routed proxies.
- **Subagent Overrides:** Defined individually in agent frontmatter (`model: "..."`).
- **Inventory Rule:** If unconfigured and no runtime evidence exists, returns empty inventory `[]` (never fabricates).

## 8. Reasoning Mechanism
- **Native Host Field:** `thinking` (or `reasoning_effort`)
- **Thinking Configuration:**
  - `thinking: { "type": "enabled", "budget_tokens": 4096 }`
  - Or `supported_effort_values: ["low", "medium", "high"]`
- **Honest Reporting:** If no thinking/reasoning is configured, reports `reasoning.state = "unknown"`, `supported_effort_values = []`, and `inspectReasoningOptions.supported_values = []`. Does not synthesize fake effort arrays.

## 9. Subagent Mechanism
- **File Format:** Markdown files with YAML frontmatter located in `.claude/agents/*.md`:
  ```markdown
  ---
  name: "worker-agent"
  model: "claude-3-5-haiku-20241022"
  description: "Delegated explorer"
  ---
  Agent prompt and instructions.
  ```
- **Capability Evidence:**
  - Presence of `.claude/agents/` directory or custom agent files evidences `subagents.state = "available"`.
  - In absence of agent directory or files, reports `unknown`.
- **Per-Agent Model Control:** Supported via `model` frontmatter attribute in each agent markdown file.

## 10. Parallelism Mechanism
- Derived strictly from `concurrency` or `max_concurrency` setting in configuration, or `CLAUDE_MAX_CONCURRENCY` environment variable.
- If concurrency limit > 1 is evidenced: `parallelism.state = "available"`, `supports_parallel_execution: true`.
- If unconfirmed: `parallelism.state = "unknown"`, `supports_parallel_execution: false`.

## 11. Mutation Targets
- `<workspace>/.claude/settings.json` (or `.claude.json`): updates model, thinking.
- `<workspace>/.claude/mcp.json`: adds `agent-config` companion MCP server.
- `<workspace>/.claude/agents/<ticket_id>.md`: generates isolated subagent instructions with frontmatter.

## 12. Known Unsupported Capabilities
- Live session memory mutation without restarting or resetting session context.
- Arbitrary non-JSON configuration files (Claude Code is strictly JSON / Markdown frontmatter).

## 13. Known Unknown Capabilities
- Dynamic cloud token quotas and rate limit concurrency bounds when running in unmetered interactive CLI sessions without host telemetry.
