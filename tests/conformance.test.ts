import { describe, it, expect } from "vitest";
import { runAdapterConformanceSuite } from "./conformance/adapter-conformance.suite.js";
import { GenericAdapter } from "../src/adapters/generic/index.js";
import { CodexAdapter } from "../src/adapters/codex/index.js";
import { OpenCodeAdapter } from "../src/adapters/opencode/index.js";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code/index.js";
import { GeminiCliAdapter } from "../src/adapters/gemini-cli/index.js";
import { CursorAdapter } from "../src/adapters/cursor/index.js";
import { DshAdapter } from "../src/adapters/dsh/index.js";
import { GrokBuildAdapter } from "../src/adapters/grok-build/index.js";
import { ZCodeAdapter } from "../src/adapters/zcode/index.js";
import { HermesAdapter } from "../src/adapters/hermes/index.js";
import { PiAdapter } from "../src/adapters/pi/index.js";
import { AdapterRegistry } from "../src/adapters/registry.js";

describe("Shared Adapter Contract Conformance Verification (§81)", () => {
  describe("Exact Native Adapter Count & Registration (§2, §3, §70)", () => {
    it("asserts exact native adapter count = 10, generic fallback = 1, and Pi is present in native adapters", () => {
      const registry = new AdapterRegistry();
      const allAdapters = registry.listAdapters();
      const nativeAdapters = allAdapters.filter((a) => a.id !== "generic");

      expect(nativeAdapters.length).toBe(10);
      expect(allAdapters.length).toBe(11);

      const nativeIds = nativeAdapters.map((a) => a.id).sort();
      // Note: gemini-cli is the canonical adapter ID for antigravity/gemini family in registry
      expect(nativeIds).toEqual([
        "claude-code",
        "codex",
        "cursor",
        "dsh",
        "gemini-cli",
        "grok-build",
        "hermes",
        "opencode",
        "pi",
        "zcode",
      ]);

      // Assert Pi is in registry
      expect(allAdapters.map((a) => a.id)).toContain("pi");
    });
  });

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

  // ZCode Adapter
  runAdapterConformanceSuite(() => new ZCodeAdapter(), {
    adapterName: "ZCodeAdapter",
    sampleExecutionConfig: {
      execution_id: "zcode-conformance-plan",
      controller: { model: "zcode-default" },
      execution: { model: "zcode-default" },
    },
  });

  // Hermes Adapter
  runAdapterConformanceSuite(() => new HermesAdapter(), {
    adapterName: "HermesAdapter",
    sampleExecutionConfig: {
      execution_id: "hermes-conformance-plan",
      controller: { model: "hermes-default" },
      execution: { model: "hermes-default" },
    },
  });

  // Pi Adapter
  runAdapterConformanceSuite(() => new PiAdapter(), {
    adapterName: "PiAdapter",
    sampleExecutionConfig: {
      execution_id: "pi-conformance-plan",
      controller: { model: "gemini-3.8-flash-high" },
      execution: { model: "gemini-3.8-flash-high" },
    },
  });
});
