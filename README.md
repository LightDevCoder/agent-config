# Agent Config Companion MCP Server

> Companion MCP runtime for cross-harness host inspection, profile persistence, and execution configuration.

## Overview

`agent-config` is an independent Model Context Protocol (MCP) server that acts as the companion runtime for the `agent-config` Skill.

### Architectural Separation

The system uses a strict two-repository architecture:

```text
skills/agent-config (Skill)
       │  (Reasoning & Policy)
       │  • Task shape assessment (single-pass vs decomposed)
       │  • Work-item difficulty assessment (routine / moderate / demanding / critical)
       │  • Execution tier selection (routine / standard / high / review)
       │  • Execution topology selection (single session / controller-workers)
       ▼
agent-config (Companion MCP Server)
       │  (Runtime & Persistence)
       ├─ inspect_host: Inspect host capabilities & available models
       ├─ get_profile / save_profile: Atomic, host-scoped profile persistence
       ├─ preview_configuration: Generates preview diff & hash
       ├─ apply_configuration: Mutates host configuration via Adapter
       └─ validate_configuration: Confirms applied state matches expected
       ▼
Host Adapters
       ├─ Native (10): Codex, Claude Code, Antigravity / agy, DeepSeek Harness (DSH), OpenCode, ZCode, Cursor, Grok Build, Hermes, Pi
       └─ Generic Adapter (plan-only fallback)
```

## Installation

Clone and install globally:

```bash
git clone https://github.com/LightDevCoder/agent-config.git
cd agent-config
npm ci
npm run build
npm install -g .
```

Verify that the CLI is available and can probe the environment:

```bash
agent-config setup --check
```

*(Note: `setup --check` returns non-zero exit code when the companion is not yet registered or configured for the current workspace. This confirms the CLI is functional.)*

### Companion MCP Registration

To preview and apply companion MCP registration into your current agent host configuration:

```bash
# Preview registration diff (read-only)
agent-config setup --preview

# Apply registration with explicit approval
agent-config setup --apply --yes

# Validate health after registration
agent-config setup --check
```

### Relationship with `LightDevCoder/skills`

- **Skill (`agent-config`):** Installed from [LightDevCoder/skills](https://github.com/LightDevCoder/skills):
  ```bash
  npx skills add LightDevCoder/skills --skill agent-config
  ```
- **Companion MCP Runtime (this repository):** Provides optional host inspection, profile persistence, configuration preview/apply, and health verification. Without the companion, the Skill remains fully functional in session-local, plan-only mode.

## Core Principles

1. **Cross-Harness by Design:**
   Designed from the start for seamless operation across different agent hosts (Codex, OpenCode, Claude Code, Cursor, generic).

2. **Single-Model as a First-Class Citizen:**
   Single-model mode is NOT a degraded fallback; it is a primary operating mode with full topology, concurrency, thread dispatch, and effort controls.

3. **Strict Separation of Evidence and Tier Mappings:**
   - Host inspection reports factual model availability and supported discrete effort values.
   - Capability tiers (`routine`, `standard`, `high`, `review`) are exclusively mapped by the user during setup.
   - **No model intelligence guessing:** The runtime forbids static ranking fields (`routing_rank`) or heuristic guessing based on model names.

4. **Abstract Effort Policies vs. Host Discrete Values:**
   - Profiles and plans can specify abstract policies (e.g. `highest-supported`, `default`, `lowest-supported`).
   - Adapters resolve policies into the concrete discrete string values actually supported by the host (e.g. `high`).

5. **Safe Mutation Gate:**
   Configuration changes always require explicit preview generation before application (`preview_configuration` → `apply_configuration`), followed by post-mutation validation (`validate_configuration`).

## Standard MCP Tool Surface

| Tool | Purpose |
|---|---|
| `get_setup_status` | Returns whether the current host/workspace has a configured profile, its version, and stale status. |
| `inspect_host` | Queries the active Host Adapter for available models, supported effort values, and concurrency/subagent capabilities. |
| `get_profile` | Retrieves the stored, user-confirmed profile for the current host and workspace scope. |
| `save_profile` | Validates against schema and host inventory, then atomically persists the profile. |
| `preview_configuration` | Previews configuration changes and produces a verifiable preview hash/ID. |
| `apply_configuration` | Applies a previously previewed configuration via the corresponding Host Adapter. |
| `validate_configuration` | Compares host state with a canonical `expected_config` or a known workspace/host-bound `preview_id`; rejects missing or invalid baselines. |
| `reset_profile` | Clears stored profile configuration for the current host and workspace. |

## Canonical Schemas

Schemas are defined under `schemas/` and canonical contracts under `src/contracts/`:

- `schemas/profile.schema.json`: User-confirmed profile schema (host+workspace scoped, single/multi modes, tier mapping, abstract effort policies).
- `schemas/host-capabilities.schema.json`: Host capability evidence schema (models inventory, discrete effort values, concurrency, subagents/threads).
- `schemas/execution-config.schema.json`: Resolved execution configuration schema (topology, controller/worker models and resolved discrete effort values).
- `schemas/preview.schema.json`: Canonical configuration preview schema (`preview_id`, `preview_hash`, `diff`, `expires_at`, `target`, `baseline_hash`).
- `schemas/apply.schema.json`: Canonical apply mutation result schema (`preview_id`, `applied_targets`, `target`, `baseline_hash`, `message`).
- `schemas/validation.schema.json`: Canonical post-apply host validation schema (`valid`, `workspace`, `message`, `details`).
- `schemas/companion-contract.schema.json`: Canonical companion MCP contract specification covering protocol version 1, all 8 tools, request/response schemas, and error format.

## Harness Support Matrix

| Harness | Tier | Scope | Configuration Path | MCP Registration |
|---|---|---|---|---|
| Codex CLI | Native | Project / User | `.codex/config.toml` (or `$CODEX_HOME/config.toml`) | `.codex/config.toml` (`[mcp_servers.agent-config]`) |
| Claude Code | Native | Project / User | `.mcp.json` / `~/.claude.json` | `.mcp.json` (project) / `~/.claude.json` (user) |
| Antigravity / agy | Native | Project / User | `.gemini/config.json` | `.gemini/config.json` |
| DeepSeek Harness (DSH) | Native | Project / User | `cordis.patch.yml` / `$DSH_HOME/profiles/<name>/cordis.patch.yml` | `@deepseek-ai/dsh-mcp-client` in `cordis.patch.yml` |
| OpenCode | Native | Project / User | `opencode.json` / `opencode.jsonc` | `opencode.json` / `opencode.jsonc` |
| ZCode | Native | Project / User | `<workspace>/.zcode/config.json` / `~/.zcode/cli/config.json` | `.zcode/config.json` (`mcp.servers["agent-config"]`) |
| Cursor | Native | Project / User | `.cursor/settings.json` | `.cursor/mcp.json` |
| Grok Build | Native | Project / User | `.grok/config.toml` | `.grok/config.toml` |
| Hermes | Native | User / Project | `~/.hermes/config.json` | `~/.hermes/config.json` |
| Pi Coding Agent | Native settings; MCP extension required | Project / User | `.pi/settings.json` / `~/.pi/agent/settings.json` | `.pi/mcp.json` (project) / `~/.pi/agent/mcp.json` (user) |
| Generic / Fallback | Fallback | Plan-only | N/A (read-only execution plan) | Manual export |

Pi MCP registration requires an installed and enabled `npm:pi-mcp-adapter` package and a Pi restart/reload. Project settings additionally require Pi project trust. The adapter verifies model/provider pairs and model-specific thinking evidence; extension dispatch capabilities remain unknown until evidenced. See [Pi adapter](docs/adapters/pi.md).

## Setup CLI & Companion Health Verification

The companion provides a standalone CLI runner for safe host registration and health verification:

- `agent-config setup --check`: Executes a live MCP protocol and contract probe.
  - **Exit semantics:** Exits with code `0` only when the Companion is healthy and ready; exits non-zero (`1`) if unregistered, unreachable, or unhealthy.
  - **Strict state separation:** Distinguishes `Registered`, `Configured`, `Reachable`, and `Healthy` (`registration != reachability != health`).
  - **Canonical health definition:** Requires syntactically valid registration, live process reachability, compatible MCP transport protocol, exact Agent Config Companion contract version match (`protocol_version === 1`), and all 8 canonical tools with compatible input and output schemas.
- `agent-config setup --preview`: Read-only inspection generating a unified diff and mutation ownership block.
- `agent-config setup --apply --yes`: Atomically applies host configuration mutations. Requires explicit approval (`--yes`). Full setup completion requires post-mutation health probe verification; registration mutation success alone does not mean setup completion.

## Development

```bash
# Install dependencies
npm install

# Type-check
npm run check:types

# Build TypeScript to dist/
npm run build

# Run test suite
npm test
```

## License

MIT License. See [LICENSE](LICENSE) for details.
