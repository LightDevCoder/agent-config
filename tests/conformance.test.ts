import { describe } from "vitest";
import { runAdapterConformanceSuite } from "./conformance/adapter-conformance.suite.js";
import { GenericAdapter } from "../src/adapters/generic/index.js";
import { CodexAdapter } from "../src/adapters/codex/index.js";
import { OpenCodeAdapter } from "../src/adapters/opencode/index.js";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code/index.js";
import { CopilotCliAdapter } from "../src/adapters/copilot-cli/index.js";
import { GeminiCliAdapter } from "../src/adapters/gemini-cli/index.js";
import { CursorAdapter } from "../src/adapters/cursor/index.js";
import { KiroAdapter } from "../src/adapters/kiro/index.js";
import { ZedAdapter } from "../src/adapters/zed/index.js";
import { GrokBuildAdapter } from "../src/adapters/grok-build/index.js";
import { DshAdapter } from "../src/adapters/dsh/index.js";
import { AmpAdapter } from "../src/adapters/amp/index.js";
import { WindsurfAdapter } from "../src/adapters/windsurf/index.js";
import { ClineAdapter } from "../src/adapters/cline/index.js";
import { RooCodeAdapter } from "../src/adapters/roo-code/index.js";

describe("Shared Adapter Contract Conformance Verification (§81)", () => {
  // Generic / Fallback Adapter
  runAdapterConformanceSuite(() => new GenericAdapter(), {
    adapterName: "GenericAdapter",
  });

  // Codex Adapter
  runAdapterConformanceSuite(() => new CodexAdapter(), {
    adapterName: "CodexAdapter",
    sampleExecutionConfig: {
      execution_id: "codex-conformance-plan",
      controller: { model: "gpt-4o" },
      execution: { model: "gpt-4o" },
    },
  });

  // OpenCode Adapter
  runAdapterConformanceSuite(() => new OpenCodeAdapter(), {
    adapterName: "OpenCodeAdapter",
    sampleExecutionConfig: {
      execution_id: "opencode-conformance-plan",
      controller: { model: "anthropic/claude-3-7-sonnet" },
      execution: { model: "anthropic/claude-3-7-sonnet" },
    },
  });

  // Claude Code Adapter
  runAdapterConformanceSuite(() => new ClaudeCodeAdapter(), {
    adapterName: "ClaudeCodeAdapter",
    sampleExecutionConfig: {
      execution_id: "claude-code-conformance-plan",
      controller: { model: "claude-3-7-sonnet-20250219" },
      execution: { model: "claude-3-7-sonnet-20250219" },
    },
  });

  // GitHub Copilot CLI Adapter
  runAdapterConformanceSuite(() => new CopilotCliAdapter(), {
    adapterName: "CopilotCliAdapter",
    sampleExecutionConfig: {
      execution_id: "copilot-cli-conformance-plan",
      controller: { model: "gpt-4o" },
      execution: { model: "gpt-4o" },
    },
  });

  // Gemini CLI Adapter
  runAdapterConformanceSuite(() => new GeminiCliAdapter(), {
    adapterName: "GeminiCliAdapter",
    sampleExecutionConfig: {
      execution_id: "gemini-cli-conformance-plan",
      controller: { model: "gemini-2.0-flash" },
      execution: { model: "gemini-2.0-flash" },
    },
  });

  // Cursor Adapter
  runAdapterConformanceSuite(() => new CursorAdapter(), {
    adapterName: "CursorAdapter",
    sampleExecutionConfig: {
      execution_id: "cursor-conformance-plan",
      controller: { model: "claude-3-7-sonnet" },
      execution: { model: "claude-3-7-sonnet" },
    },
  });

  // Kiro Adapter
  runAdapterConformanceSuite(() => new KiroAdapter(), {
    adapterName: "KiroAdapter",
    sampleExecutionConfig: {
      execution_id: "kiro-conformance-plan",
      controller: { model: "claude-3-7-sonnet" },
      execution: { model: "claude-3-7-sonnet" },
    },
  });

  // Zed Adapter
  runAdapterConformanceSuite(() => new ZedAdapter(), {
    adapterName: "ZedAdapter",
    sampleExecutionConfig: {
      execution_id: "zed-conformance-plan",
      controller: { model: "claude-3-7-sonnet" },
      execution: { model: "claude-3-7-sonnet" },
    },
  });

  // DeepSeek Harness (DSH) Adapter
  runAdapterConformanceSuite(() => new DshAdapter(), {
    adapterName: "DshAdapter",
    sampleExecutionConfig: {
      execution_id: "dsh-conformance-plan",
      controller: { model: "deepseek-chat" },
      execution: { model: "deepseek-chat" },
    },
  });

  // Grok Build Adapter
  runAdapterConformanceSuite(() => new GrokBuildAdapter(), {
    adapterName: "GrokBuildAdapter",
    sampleExecutionConfig: {
      execution_id: "grok-build-conformance-plan",
      controller: { model: "grok-2" },
      execution: { model: "grok-2" },
    },
  });

  // Amp Adapter (P1)
  runAdapterConformanceSuite(() => new AmpAdapter(), {
    adapterName: "AmpAdapter",
    sampleExecutionConfig: {
      execution_id: "amp-conformance-plan",
      controller: { model: "claude-3-7-sonnet" },
      execution: { model: "claude-3-7-sonnet" },
    },
  });

  // Windsurf Adapter (P1)
  runAdapterConformanceSuite(() => new WindsurfAdapter(), {
    adapterName: "WindsurfAdapter",
    sampleExecutionConfig: {
      execution_id: "windsurf-conformance-plan",
      controller: { model: "claude-3-7-sonnet" },
      execution: { model: "claude-3-7-sonnet" },
    },
  });

  // Cline Adapter (P1)
  runAdapterConformanceSuite(() => new ClineAdapter(), {
    adapterName: "ClineAdapter",
    sampleExecutionConfig: {
      execution_id: "cline-conformance-plan",
      controller: { model: "claude-3-7-sonnet" },
      execution: { model: "claude-3-7-sonnet" },
    },
  });

  // Roo Code Adapter (P1)
  runAdapterConformanceSuite(() => new RooCodeAdapter(), {
    adapterName: "RooCodeAdapter",
    sampleExecutionConfig: {
      execution_id: "roo-code-conformance-plan",
      controller: { model: "claude-3-7-sonnet" },
      execution: { model: "claude-3-7-sonnet" },
    },
  });
});
