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
       ├─ Native (9): Codex, Claude Code, Antigravity / Gemini CLI, DeepSeek Harness (DSH), OpenCode, ZCode, Cursor, Grok Build, Hermes
       └─ Generic Adapter (plan-only fallback)
```

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
| `validate_configuration` | Confirms the host runtime state reflects the applied configuration. |
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
| Codex CLI | Native | Project / User | `.codex/config.toml` | `.codex/mcp.json` |
| Claude Code | Native | Project / User | `.claude.json` | `.claude/mcp.json` / `~/.claude.json` |
| Antigravity / Gemini CLI | Native | Project / User | `.gemini/config.json` | `.gemini/config.json` |
| DeepSeek Harness (DSH) | Native | Project / User | `dsh.config.json` | `dsh.config.json` |
| OpenCode | Native | Project / User | `opencode.json` / `opencode.jsonc` | `opencode.json` / `opencode.jsonc` |
| ZCode | Native (Identity Freeze Pending) | Project / User | TBD (Ticket 06) | TBD |
| Cursor | Native | Project / User | `.cursor/settings.json` | `.cursor/mcp.json` |
| Grok Build | Native | Project / User | `.grok/config.toml` | `.grok/config.toml` |
| Hermes | Native | User / Project | `~/.hermes/config.json` | `~/.hermes/config.json` |
| Generic / Fallback | Fallback | Plan-only | N/A (read-only execution plan) | Manual export |

### Deferred Harnesses

- **Pi**: Explicitly DEFERRED (SPEC §3). Pi is not included as a native adapter in v1; environments using Pi route through the Generic / manual fallback.

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
