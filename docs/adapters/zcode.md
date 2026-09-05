# ZCode Adapter Evidence Record (§10, §45)

## Adapter ID
- **Adapter ID:** `zcode`
- **Aliases:** `[]`

## Product / Harness Identity
- **Product Name:** ZCode (Desktop App & Embedded ZCode Agent CLI)
- **Harness ID:** `zcode`
- **Vendor / Publisher:** Z.AI (`dev@zcode.z.ai`, `https://zcode.z.ai`)
- **Bundle ID:** `dev.zcode.app`
- **Installed Executables & Paths on Host:**
  - Desktop Application: `/Applications/ZCode.app/Contents/MacOS/ZCode`
  - Embedded CLI JavaScript Bundle: `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`
  - Computer Use Helper: `/Applications/ZCode.app/Contents/Resources/cua-helper/ZCode Computer Use.app`
  - User Directory: `~/.zcode` (containing `cli/`, `v2/`, `skills/`, `workspace/`, `plugins/`)
  - User CLI Config: `~/.zcode/cli/config.json` (also fallback `~/.agents/mcp.json`)
  - User V2 App State: `~/.zcode/v2/config.json`, `~/.zcode/v2/setting.json`

## Version Checked & Date Checked
- **Version Checked:**
  - Desktop Application: `3.11.2` (build `3.11.2.6792`)
  - Embedded CLI Runtime: `0.16.5` (`zcode --version` from `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`)
- **Date Checked:** 2026-09-05

## Official Upstream, Documentation, & Config Schema Sources
- **Official Upstream:** `https://zcode.z.ai`
- **Official Documentation:** Embedded ZCode guide (`zcode-guide:zcode-configuration-guide`, `zcode-guide:diagnosing-mcp`) and desktop documentation.
- **Config & Schema Sources:**
  - Embedded guide skills: `~/.zcode/cli/plugins/cache/zcode-plugins-official/zcode-guide/0.1.0/skills/zcode-configuration-guide/SKILL.md`
  - MCP schema guide: `~/.zcode/cli/plugins/cache/zcode-plugins-official/zcode-guide/0.1.0/skills/diagnosing-mcp/SKILL.md`
  - Built-in models catalog: `/Applications/ZCode.app/Contents/Resources/model-providers/models_catalog_china_llm_zcode_2026-06-03.json`

## Executable Detection & Version Detection
- **Executable Detection:**
  - `which zcode` (if symlinked to PATH)
  - Desktop app presence: `/Applications/ZCode.app`
  - Embedded CLI bundle: `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`
  - Process environment: `process.env.ZCODE_SESSION_ID`, `process.env.ZCODE`, `process.env.ZCODE_CONFIG`
  - Process title / path containing `zcode`
- **Version Detection:**
  - `node /Applications/ZCode.app/Contents/Resources/glm/zcode.cjs --version` -> `0.16.5`
  - `/Applications/ZCode.app/Contents/Info.plist` CFBundleShortVersionString -> `3.11.2`
  - Environment: `process.env.ZCODE_VERSION`
- **Compatibility Classification:**
  - Embedded CLI `0.x`, `1.x`: `supported`
  - Desktop App `3.x`: `supported`
  - Unknown or unverified: `unknown-version` (`fail_closed_for_mutation: true`)

## Config Files, Scopes, & Precedence
- **User Scopes:**
  - CLI Config: `~/.zcode/cli/config.json`
  - Fallback MCP: `~/.agents/mcp.json`
  - App Settings: `~/.zcode/v2/config.json`, `~/.zcode/v2/setting.json`
- **Workspace Scopes:**
  - `<workspace>/.zcode/config.json` or `<workspace>/zcode.json`
  - Compatibility fallback: `<workspace>/.agents/mcp.json`
- **Precedence Rules (Official ZCode Documentation):**
  - For same-named MCP servers: CLI override -> environment -> user (`~/.zcode/cli/config.json`) -> workspace (`<workspace>/.zcode/config.json`).
  - Note: In ZCode's native design, **user configuration overrides workspace configuration for MCP servers** (with workspace servers auto-connected by default).
  - For Skills and Commands: Earlier locations take precedence: user scope (`~/.zcode/skills`, `~/.agents/skills`) shadows workspace scope (`<workspace>/.zcode/skills`, `<workspace>/.agents/skills`).
  - For Instructions (`AGENTS.md`): `~/.zcode/AGENTS.md` loads first, then workspace `<workspace>/AGENTS.md` loads later so workspace instructions can narrow or override user defaults.

## Model Mechanism & Selection
- **Providers Evidenced:** `builtin:bigmodel`, `builtin:bigmodel-coding-plan`, `builtin:zai-start-plan`, `builtin:zai`, `anthropic`, `openai-compatible`.
- **Selected Model Format:** Provider-qualified ID, e.g. `builtin:bigmodel/GLM-5.3`, `builtin:bigmodel/GLM-5.3-Flash`, `builtin:bigmodel/GLM-5-Turbo`.
- **Model Catalog Definition:** Top-level `provider.<provider_id>.models.<model_id>` in `~/.zcode/v2/config.json` or embedded model catalogs.

## Reasoning Mechanism
- **Native Field:** `reasoning` (object with `variants: ["low", "max", "high"]`, `defaultVariant: "max"` or `levels`).
- **Policy Mapping:**
  - `highest-supported`: maps to `max` if present, else highest variant.
  - `lowest-sufficient` / `lowest-supported`: maps to `low`.

## Execution Topology & Subagents
- **Topology:** Supports single session, multi-session, subagents (via `zcode-expert`, `zcode-workflow`, or subagent profiles in `~/.zcode/cli/agents`).
- **Parallelism:** Supported via background jobs and workflow orchestrator.

## MCP Mechanism & Registration
- **Configuration Format:** Embedded in `~/.zcode/cli/config.json` or `<workspace>/.zcode/config.json` under `mcp.servers.<name>`.
- **Schema:**
  ```json
  {
    "mcp": {
      "servers": {
        "agent-config": {
          "type": "stdio",
          "command": "agent-config",
          "args": ["serve"]
        }
      }
    }
  }
  ```
- **Registration Scopes:** Project scope (`<workspace>/.zcode/config.json`) and User scope (`~/.zcode/cli/config.json`).
- **Auto-Connect:** All scopes auto-connect on session start.

## Mutation Strategy & Fail-Closed Behavior
- Reads layered configuration across workspace and user locations.
- Mutates target JSON configuration preserving unrelated fields.
- Fails closed for unknown versions or unevidenced environments.
