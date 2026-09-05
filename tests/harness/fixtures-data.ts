import path from "node:path";
import fs from "node:fs";

export interface FixtureFile {
  relativePath: string;
  content: string;
}

export interface FixtureScenario {
  name: string;
  files: FixtureFile[];
}

export interface HarnessFixtures {
  harness: string;
  scenarios: Record<string, FixtureFile[]>;
}

export const REQUIRED_HARNESSES = [
  "codex",
  "claude-code",
  "opencode",
  "gemini-cli",
  "cursor",
  "dsh",
  "grok-build",
  "zcode",
  "hermes",
] as const;

export const REQUIRED_SCENARIOS = [
  "minimal",
  "single-model",
  "multi-model",
  "mcp-configured",
  "mcp-absent",
  "unknown-capability",
  "malformed",
  "stale-profile",
] as const;

export const FIXTURES_DEFINITIONS: Record<string, Record<string, FixtureFile[]>> = {
  codex: {
    minimal: [{ relativePath: ".codex/config.toml", content: "[codex]\n" }],
    "single-model": [
      { relativePath: ".codex/config.toml", content: 'model = "gpt-4o"\n' },
    ],
    "multi-model": [
      {
        relativePath: ".codex/config.toml",
        content:
          'model = "gpt-4o"\nworker_model = "o3-mini"\nsupported_models = ["gpt-4o", "o3-mini", "o1"]\n',
      },
    ],
    "mcp-configured": [
      {
        relativePath: ".codex/config.toml",
        content:
          'model = "gpt-4o"\n\n[mcp_servers.agent-config]\ncommand = "agent-config"\nargs = ["serve"]\n',
      },
      {
        relativePath: ".codex/mcp.json",
        content: JSON.stringify(
          {
            mcpServers: {
              "agent-config": {
                command: "agent-config",
                args: ["serve"],
              },
            },
          },
          null,
          2
        ),
      },
    ],
    "mcp-absent": [
      { relativePath: ".codex/config.toml", content: 'model = "gpt-4o"\n' },
      { relativePath: ".codex/mcp.json", content: JSON.stringify({ mcpServers: {} }, null, 2) },
    ],
    "unknown-capability": [
      { relativePath: ".codex/config.toml", content: 'model = "gpt-4o"\n' },
    ],
    malformed: [
      {
        relativePath: ".codex/config.toml",
        content: 'model = "gpt-4o"\n[unclosed_table\nfoo = bar\n',
      },
    ],
    "stale-profile": [
      { relativePath: ".codex/config.toml", content: 'model = "gpt-4o"\n' },
      {
        relativePath: ".agent-profile.json",
        content: JSON.stringify(
          {
            schema_version: "1.0",
            host_id: "codex",
            fingerprint: "stale-fp-001",
            generated_at: "2024-01-01T00:00:00.000Z",
            single_model: { model: "nonexistent-gpt-99" },
          },
          null,
          2
        ),
      },
    ],
  },

  "claude-code": {
    minimal: [{ relativePath: ".claude.json", content: "{}\n" }],
    "single-model": [
      {
        relativePath: ".claude.json",
        content: JSON.stringify({ model: "claude-3-7-sonnet" }, null, 2),
      },
    ],
    "multi-model": [
      {
        relativePath: ".claude.json",
        content: JSON.stringify(
          {
            model: "claude-3-7-sonnet",
            subagents: {
              worker: { model: "claude-3-5-haiku" },
            },
          },
          null,
          2
        ),
      },
    ],
    "mcp-configured": [
      {
        relativePath: ".claude.json",
        content: JSON.stringify(
          {
            model: "claude-3-7-sonnet",
            mcpServers: {
              "agent-config": {
                command: "agent-config",
                args: ["serve"],
              },
            },
          },
          null,
          2
        ),
      },
    ],
    "mcp-absent": [
      {
        relativePath: ".claude.json",
        content: JSON.stringify(
          {
            model: "claude-3-7-sonnet",
            mcpServers: {},
          },
          null,
          2
        ),
      },
    ],
    "unknown-capability": [
      {
        relativePath: ".claude.json",
        content: JSON.stringify({ model: "claude-3-7-sonnet" }, null, 2),
      },
    ],
    malformed: [
      {
        relativePath: ".claude.json",
        content: '{"model": "claude-3-7-sonnet", invalid json...',
      },
    ],
    "stale-profile": [
      {
        relativePath: ".claude.json",
        content: JSON.stringify({ model: "claude-3-7-sonnet" }, null, 2),
      },
      {
        relativePath: ".agent-profile.json",
        content: JSON.stringify(
          {
            schema_version: "1.0",
            host_id: "claude-code",
            fingerprint: "stale-fp-002",
            generated_at: "2024-01-01T00:00:00.000Z",
            single_model: { model: "claude-1.0-legacy" },
          },
          null,
          2
        ),
      },
    ],
  },

  opencode: {
    minimal: [{ relativePath: "opencode.json", content: "{}\n" }],
    "single-model": [
      {
        relativePath: "opencode.json",
        content: JSON.stringify({ model: "anthropic/claude-3-7-sonnet" }, null, 2),
      },
    ],
    "multi-model": [
      {
        relativePath: "opencode.json",
        content: JSON.stringify(
          {
            model: "anthropic/claude-3-7-sonnet",
            worker_model: "anthropic/claude-3-5-haiku",
            providers: {
              openai: { models: ["gpt-4o"] },
              anthropic: { models: ["claude-3-7-sonnet", "claude-3-5-haiku"] },
            },
          },
          null,
          2
        ),
      },
    ],
    "mcp-configured": [
      {
        relativePath: "opencode.json",
        content: JSON.stringify(
          {
            model: "anthropic/claude-3-7-sonnet",
            mcp: {
              "agent-config": {
                type: "local",
                command: "agent-config",
                args: ["serve"],
              },
            },
          },
          null,
          2
        ),
      },
    ],
    "mcp-absent": [
      {
        relativePath: "opencode.json",
        content: JSON.stringify(
          {
            model: "anthropic/claude-3-7-sonnet",
          },
          null,
          2
        ),
      },
    ],
    "unknown-capability": [
      {
        relativePath: "opencode.json",
        content: JSON.stringify({ model: "anthropic/claude-3-7-sonnet" }, null, 2),
      },
    ],
    malformed: [
      {
        relativePath: "opencode.json",
        content: '{"model": "broken", invalid JSON',
      },
    ],
    "stale-profile": [
      {
        relativePath: "opencode.json",
        content: JSON.stringify({ model: "anthropic/claude-3-7-sonnet" }, null, 2),
      },
      {
        relativePath: ".agent-profile.json",
        content: JSON.stringify(
          {
            schema_version: "1.0",
            host_id: "opencode",
            fingerprint: "stale-fp-003",
            generated_at: "2024-01-01T00:00:00.000Z",
            single_model: { model: "unknown-provider/deprecated-model" },
          },
          null,
          2
        ),
      },
    ],
  },

  "gemini-cli": {
    minimal: [{ relativePath: ".gemini/config.json", content: "{}\n" }],
    "single-model": [
      {
        relativePath: ".gemini/config.json",
        content: JSON.stringify({ model: "gemini-2.0-flash" }, null, 2),
      },
    ],
    "multi-model": [
      {
        relativePath: ".gemini/config.json",
        content: JSON.stringify(
          {
            model: "gemini-2.0-flash",
            fallback_model: "gemini-2.0-pro",
            available_models: ["gemini-2.0-flash", "gemini-2.0-pro"],
          },
          null,
          2
        ),
      },
    ],
    "mcp-configured": [
      {
        relativePath: ".gemini/config.json",
        content: JSON.stringify(
          {
            model: "gemini-2.0-flash",
            mcp: {
              servers: {
                "agent-config": {
                  command: "agent-config",
                  args: ["serve"],
                },
              },
            },
          },
          null,
          2
        ),
      },
    ],
    "mcp-absent": [
      {
        relativePath: ".gemini/config.json",
        content: JSON.stringify(
          {
            model: "gemini-2.0-flash",
            mcp: { servers: {} },
          },
          null,
          2
        ),
      },
    ],
    "unknown-capability": [
      {
        relativePath: ".gemini/config.json",
        content: JSON.stringify({ model: "gemini-2.0-flash" }, null, 2),
      },
    ],
    malformed: [
      {
        relativePath: ".gemini/config.json",
        content: '{"model": "gemini-2.0-flash", [broken syntax',
      },
    ],
    "stale-profile": [
      {
        relativePath: ".gemini/config.json",
        content: JSON.stringify({ model: "gemini-2.0-flash" }, null, 2),
      },
      {
        relativePath: ".agent-profile.json",
        content: JSON.stringify(
          {
            schema_version: "1.0",
            host_id: "gemini-cli",
            fingerprint: "stale-fp-004",
            generated_at: "2024-01-01T00:00:00.000Z",
            single_model: { model: "gemini-0.9-retired" },
          },
          null,
          2
        ),
      },
    ],
  },

  cursor: {
    minimal: [{ relativePath: ".cursor/settings.json", content: "{}\n" }],
    "single-model": [
      {
        relativePath: ".cursor/settings.json",
        content: JSON.stringify({ "cursor.model": "claude-3-7-sonnet" }, null, 2),
      },
    ],
    "multi-model": [
      {
        relativePath: ".cursor/settings.json",
        content: JSON.stringify(
          {
            "cursor.model": "claude-3-7-sonnet",
            "cursor.models": ["claude-3-7-sonnet", "gpt-4o"],
          },
          null,
          2
        ),
      },
    ],
    "mcp-configured": [
      {
        relativePath: ".cursor/settings.json",
        content: JSON.stringify({ "cursor.model": "claude-3-7-sonnet" }, null, 2),
      },
      {
        relativePath: ".cursor/mcp.json",
        content: JSON.stringify(
          {
            mcpServers: {
              "agent-config": {
                command: "agent-config",
                args: ["serve"],
              },
            },
          },
          null,
          2
        ),
      },
    ],
    "mcp-absent": [
      {
        relativePath: ".cursor/settings.json",
        content: JSON.stringify({ "cursor.model": "claude-3-7-sonnet" }, null, 2),
      },
      {
        relativePath: ".cursor/mcp.json",
        content: JSON.stringify({ mcpServers: {} }, null, 2),
      },
    ],
    "unknown-capability": [
      {
        relativePath: ".cursor/settings.json",
        content: JSON.stringify({ "cursor.general": true }, null, 2),
      },
    ],
    malformed: [
      {
        relativePath: ".cursor/settings.json",
        content: '{"cursor.model": broken,',
      },
    ],
    "stale-profile": [
      {
        relativePath: ".cursor/settings.json",
        content: JSON.stringify({ "cursor.model": "claude-3-7-sonnet" }, null, 2),
      },
      {
        relativePath: ".agent-profile.json",
        content: JSON.stringify(
          {
            schema_version: "1.0",
            host_id: "cursor",
            fingerprint: "stale-fp-006",
            generated_at: "2024-01-01T00:00:00.000Z",
            single_model: { model: "claude-2.0-old" },
          },
          null,
          2
        ),
      },
    ],
  },

  dsh: {
    minimal: [{ relativePath: ".dsh/config.json", content: JSON.stringify({ plugins: [] }, null, 2) }],
    "single-model": [
      {
        relativePath: ".dsh/config.json",
        content: JSON.stringify(
          {
            plugins: [
              { name: "llm-provider", active: true, model: "deepseek-chat" },
            ],
          },
          null,
          2
        ),
      },
    ],
    "multi-model": [
      {
        relativePath: ".dsh/config.json",
        content: JSON.stringify(
          {
            plugins: [
              {
                name: "llm-provider",
                active: true,
                models: ["deepseek-chat", "deepseek-reasoner"],
              },
              {
                name: "subagent-provider",
                active: true,
                worker_model: "deepseek-chat",
              },
            ],
          },
          null,
          2
        ),
      },
    ],
    "mcp-configured": [
      {
        relativePath: ".dsh/config.json",
        content: JSON.stringify(
          {
            plugins: [
              { name: "llm-provider", active: true, model: "deepseek-chat" },
              {
                name: "mcp-client",
                active: true,
                servers: {
                  "agent-config": {
                    command: "agent-config",
                    args: ["serve"],
                  },
                },
              },
            ],
          },
          null,
          2
        ),
      },
    ],
    "mcp-absent": [
      {
        relativePath: ".dsh/config.json",
        content: JSON.stringify(
          {
            plugins: [
              { name: "llm-provider", active: true, model: "deepseek-chat" },
              {
                name: "mcp-client",
                active: true,
                servers: {},
              },
            ],
          },
          null,
          2
        ),
      },
    ],
    "unknown-capability": [
      {
        relativePath: ".dsh/config.json",
        content: JSON.stringify({ runtime_mode: "standalone" }, null, 2),
      },
    ],
    malformed: [
      {
        relativePath: ".dsh/config.json",
        content: '{"plugins": [ broken syntax',
      },
    ],
    "stale-profile": [
      {
        relativePath: ".dsh/config.json",
        content: JSON.stringify(
          {
            plugins: [
              { name: "llm-provider", active: true, model: "deepseek-chat" },
            ],
          },
          null,
          2
        ),
      },
      {
        relativePath: ".agent-profile.json",
        content: JSON.stringify(
          {
            schema_version: "1.0",
            host_id: "dsh",
            fingerprint: "stale-fp-009",
            generated_at: "2024-01-01T00:00:00.000Z",
            single_model: { model: "dsh-unknown-model" },
          },
          null,
          2
        ),
      },
    ],
  },

  "grok-build": {
    minimal: [{ relativePath: ".grok/config.toml", content: "[grok]\n" }],
    "single-model": [
      { relativePath: ".grok/config.toml", content: 'model = "grok-2"\n' },
    ],
    "multi-model": [
      {
        relativePath: ".grok/config.toml",
        content:
          'model = "grok-2"\nworker_model = "grok-2-mini"\nmodels = ["grok-2", "grok-2-mini"]\n',
      },
    ],
    "mcp-configured": [
      {
        relativePath: ".grok/config.toml",
        content:
          'model = "grok-2"\n\n[mcp.servers.agent-config]\ncommand = "agent-config"\nargs = ["serve"]\n',
      },
    ],
    "mcp-absent": [
      {
        relativePath: ".grok/config.toml",
        content: 'model = "grok-2"\n[mcp]\nservers = {}\n',
      },
    ],
    "unknown-capability": [
      { relativePath: ".grok/config.toml", content: 'build_target = "default"\n' },
    ],
    malformed: [
      {
        relativePath: ".grok/config.toml",
        content: '[broken toml == invalid\n',
      },
    ],
    "stale-profile": [
      { relativePath: ".grok/config.toml", content: 'model = "grok-2"\n' },
      {
        relativePath: ".agent-profile.json",
        content: JSON.stringify(
          {
            schema_version: "1.0",
            host_id: "grok-build",
            fingerprint: "stale-fp-010",
            generated_at: "2024-01-01T00:00:00.000Z",
            single_model: { model: "grok-v0-vintage" },
          },
          null,
          2
        ),
      },
    ],
  },

  zcode: {
    minimal: [
      {
        relativePath: ".zcode/config.json",
        content: JSON.stringify({ version: "0.16.5" }, null, 2),
      },
    ],
    "single-model": [
      {
        relativePath: ".zcode/config.json",
        content: JSON.stringify(
          {
            model: "builtin:bigmodel/GLM-5.3",
            provider: {
              "builtin:bigmodel": {
                models: {
                  "GLM-5.3": {
                    reasoning: { variants: ["low", "max", "high"] },
                  },
                },
              },
            },
          },
          null,
          2
        ),
      },
    ],
    "multi-model": [
      {
        relativePath: ".zcode/config.json",
        content: JSON.stringify(
          {
            model: "builtin:bigmodel/GLM-5.3",
            provider: {
              "builtin:bigmodel": {
                models: {
                  "GLM-5.3": { reasoning: { variants: ["low", "max", "high"] } },
                  "GLM-5.3-Flash": { reasoning: { variants: ["low", "high"] } },
                  "GLM-5-Turbo": {},
                },
              },
            },
          },
          null,
          2
        ),
      },
    ],
    "mcp-configured": [
      {
        relativePath: ".zcode/config.json",
        content: JSON.stringify(
          {
            model: "builtin:bigmodel/GLM-5.3",
            mcp: {
              servers: {
                "agent-config": {
                  type: "stdio",
                  command: "agent-config",
                  args: ["serve"],
                },
              },
            },
          },
          null,
          2
        ),
      },
    ],
    "mcp-absent": [
      {
        relativePath: ".zcode/config.json",
        content: JSON.stringify(
          {
            model: "builtin:bigmodel/GLM-5.3",
            mcp: { servers: {} },
          },
          null,
          2
        ),
      },
    ],
    "unknown-capability": [
      {
        relativePath: ".zcode/config.json",
        content: JSON.stringify({ theme: "dark" }, null, 2),
      },
    ],
    malformed: [
      {
        relativePath: ".zcode/config.json",
        content: "{ invalid json content == not json }",
      },
    ],
    "stale-profile": [
      {
        relativePath: ".zcode/config.json",
        content: JSON.stringify({ model: "builtin:bigmodel/GLM-5.3" }, null, 2),
      },
      {
        relativePath: ".agent-profile.json",
        content: JSON.stringify(
          {
            schema_version: "1.0",
            host_id: "zcode",
            fingerprint: "stale-fp-011",
            generated_at: "2024-01-01T00:00:00.000Z",
            single_model: { model: "zcode-nonexistent-model" },
          },
          null,
          2
        ),
      },
    ],
  },

  hermes: {
    minimal: [
      {
        relativePath: ".hermes/config.yaml",
        content: "model:\n  default: hermes-default\n",
      },
    ],
    "single-model": [
      {
        relativePath: ".hermes/config.yaml",
        content: "model:\n  default: gemini-3.8-flash-high\n",
      },
    ],
    "multi-model": [
      {
        relativePath: ".hermes/config.yaml",
        content: `model:
  default: gemini-3.8-flash-high
  aliases:
    local: omlx/Qwen3.8-9B-mlx-4Bit
providers:
  omlx:
    models:
      - Qwen3.8-9B-mlx-4Bit
custom_providers:
  - name: cpa-gui
    models:
      claude-sonnet-4-6: {}
      gpt-5.5: {}
delegation:
  model: omlx/Qwen3.8-9B-mlx-4Bit
  max_concurrent_children: 4
moa:
  reference_models:
    - model: deepseek/deepseek-v4-pro
`,
      },
    ],
    "mcp-configured": [
      {
        relativePath: ".hermes/config.yaml",
        content: `model:
  default: gemini-3.8-flash-high
mcp_servers:
  agent-config:
    command: agent-config
    args:
      - serve
`,
      },
    ],
    "mcp-absent": [
      {
        relativePath: ".hermes/config.yaml",
        content: `model:
  default: gemini-3.8-flash-high
mcp_servers: {}
`,
      },
    ],
    "unknown-capability": [
      {
        relativePath: ".hermes/config.yaml",
        content: "custom_flag: true\n",
      },
    ],
    malformed: [
      {
        relativePath: ".hermes/config.yaml",
        content: `model: [unclosed yaml list\n  bad: {indent`,
      },
    ],
    "stale-profile": [
      {
        relativePath: ".hermes/config.yaml",
        content: "model:\n  default: gemini-3.8-flash-high\n",
      },
      {
        relativePath: ".agent-profile.json",
        content: JSON.stringify(
          {
            schema_version: "1.0",
            host_id: "hermes",
            fingerprint: "stale-fp-012",
            generated_at: "2024-01-01T00:00:00.000Z",
            single_model: { model: "hermes-nonexistent-model" },
          },
          null,
          2
        ),
      },
    ],
  },
};

/**
 * Materializes all fixture files on disk under target base directory (default `tests/fixtures`).
 */
export function materializeFixtures(baseDir: string): void {
  for (const [harness, scenarios] of Object.entries(FIXTURES_DEFINITIONS)) {
    for (const [scenario, files] of Object.entries(scenarios)) {
      const scenarioDir = path.join(baseDir, harness, scenario);
      for (const file of files) {
        const fullPath = path.join(scenarioDir, file.relativePath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, file.content, "utf-8");
      }
    }
  }
}
