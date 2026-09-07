# Pi Coding Agent adapter

The adapter supports Pi settings and optional MCP registration through the separately installed `npm:pi-mcp-adapter` extension. Pi core does not load MCP files by itself. No extension is installed automatically.

## Evidence and supported scope

Reviewed against local Pi **0.85.1** (`@earendil-works/pi-coding-agent`) and its packaged `docs/settings.md`, `docs/models.md`, `docs/rpc.md`, and `docs/environment-variables.md`; MCP paths and precedence were checked against the installed `pi-mcp-adapter` README. These are source inspections, not live multi-host acceptance.

- Version: `pi --version`; verified `0.85.1` only. Unknown, prerelease, or other major versions refuse configuration mutation. Changelog preferences and synthetic version environment variables are not version evidence.
- Settings: project `.pi/settings.json`; global `$PI_CODING_AGENT_DIR/settings.json` (default `~/.pi/agent/settings.json`). Runtime execution previews target the project and never fall back to global writes.
- Pi ignores untrusted project settings. The adapter uses nearest canonical ancestor boolean entries in `trust.json`, or global `defaultProjectTrust: "always"`, to confirm persistent trust. Session-only trust is not observable here; project validation remains unsuccessful until persistent trust is confirmed.
- Models: active/default model/provider pairs and native `models.json` provider entries. Cache-only IDs without a resolvable provider are omitted from the available inventory. Provider-qualified identifiers are available for native entries. A target without a verified provider/model pair is rejected before rendering.
- Thinking: model-specific `thinkingLevelMap` from native `models.json` or local model caches. Null entries are unsupported; omitted standard entries follow Pi's documented provider defaults, while extended entries require explicit support. A runtime-observed level can evidence that level alone; arbitrary settings never imply all levels. Unsupported `max` is rejected. Target-specific `modelThinkingLevels` overrides are merged across settings layers and updated/validated ahead of the default thinking level.
- Topology: single-session execution is supported. Extension-provided subagents, per-agent routing and parallelism remain unknown; no fabricated concurrency limit is published. This adapter does not dispatch `pi-subagents`.

## MCP prerequisite and lifecycle

Registration requires the known npm package to be enabled in Pi settings and its installed package manifest to exist. Project packages additionally require persistent project trust. Alternate/custom MCP extensions are not auto-detected; use manual configuration for those installations.

The extension reads, in increasing precedence: `~/.config/mcp/mcp.json`, `~/.agents/mcp.json`, `~/.agents/mcp/mcp.json`, the Pi agent directory's `mcp.json`, project `.mcp.json`, and project `.pi/mcp.json`. Registration writes only the selected Pi override file. Disabled servers are not reported registered.

Configured files and an installed package do not prove that the current Pi session has reloaded. Restart/reload Pi after changing extensions. Adapter registration validation verifies files; the shared setup lifecycle separately probes MCP transport and all eight canonical tool contracts, preserving `registered`, `reachable`, and `healthy` as separate states.

## Regression evidence

`tests/adapters/pi.test.ts` covers version gating, provider/model evidence, thinking-map holes, local writes with existing global settings, missing effort, project trust, missing MCP extension, and frozen preview application. Shared conformance and setup lifecycle suites exercise Pi alongside the existing adapters. All use isolated fixtures; live Pi runtime invocation is not implied by their results.
