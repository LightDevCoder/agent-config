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
       ├─ Codex Adapter
       ├─ Real Non-Codex Adapter (e.g. OpenCode / Claude Code / Cursor)
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

Schemas are defined under `schemas/`:

- `schemas/profile.schema.json`: User-confirmed profile schema (host+workspace scoped, single/multi modes, tier mapping, abstract effort policies).
- `schemas/host-capabilities.schema.json`: Host capability evidence schema (models inventory, discrete effort values, concurrency, subagents/threads).
- `schemas/execution-config.schema.json`: Resolved execution configuration schema (topology, controller/worker models and resolved discrete effort values).

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
