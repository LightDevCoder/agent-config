import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  REQUIRED_HARNESSES,
  REQUIRED_SCENARIOS,
  FIXTURES_DEFINITIONS,
  materializeFixtures,
} from "./harness/fixtures-data.js";
import { createIsolatedEnv, copyFixture } from "./harness/isolated-env.js";

describe("Adapter Fixture Scaffold & Scenarios (§80)", () => {
  const fixturesDir = path.resolve(__dirname, "fixtures");

  it("materializes and maintains all required harnesses and 8 scenarios", () => {
    // Ensure fixtures are materialized
    materializeFixtures(fixturesDir);

    expect(REQUIRED_HARNESSES).toHaveLength(9);
    expect(REQUIRED_SCENARIOS).toHaveLength(8);

    for (const harness of REQUIRED_HARNESSES) {
      const harnessDir = path.join(fixturesDir, harness);
      expect(fs.existsSync(harnessDir), `Missing harness fixture dir: ${harness}`).toBe(true);

      for (const scenario of REQUIRED_SCENARIOS) {
        const scenarioDir = path.join(harnessDir, scenario);
        expect(
          fs.existsSync(scenarioDir),
          `Missing scenario dir for harness ${harness}: ${scenario}`
        ).toBe(true);

        const scenarioFiles = fs.readdirSync(scenarioDir, { recursive: true });
        expect(
          scenarioFiles.length,
          `Empty fixture scenario for harness ${harness}: ${scenario}`
        ).toBeGreaterThan(0);
      }
    }
  });

  it("verifies fixture definitions completeness across all harnesses and scenarios", () => {
    for (const harness of REQUIRED_HARNESSES) {
      const def = FIXTURES_DEFINITIONS[harness];
      expect(def, `Missing fixture definition for ${harness}`).toBeDefined();

      for (const scenario of REQUIRED_SCENARIOS) {
        const files = def[scenario];
        expect(files, `Missing scenario definition for ${harness}/${scenario}`).toBeDefined();
        expect(files.length).toBeGreaterThan(0);

        for (const file of files) {
          expect(file.relativePath).toBeDefined();
          expect(file.content.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("loads and copies fixtures safely into an isolated workspace using copyFixture()", async () => {
    const env = createIsolatedEnv();
    env.activate();

    try {
      const targetDir = path.join(env.workspaceDir, "test-fixture-load");
      await copyFixture("codex", "single-model", targetDir);

      const targetToml = path.join(targetDir, ".codex", "config.toml");
      expect(fs.existsSync(targetToml)).toBe(true);
      const content = fs.readFileSync(targetToml, "utf-8");
      expect(content).toContain('model = "gpt-4o"');
    } finally {
      await env.cleanup();
    }
  });

  it("loads multi-model and stale-profile fixtures with valid structure", async () => {
    const env = createIsolatedEnv();
    env.activate();

    try {
      const claudeMulti = path.join(env.workspaceDir, "claude-multi");
      await copyFixture("claude-code", "multi-model", claudeMulti);
      const claudeJson = JSON.parse(
        fs.readFileSync(path.join(claudeMulti, ".claude.json"), "utf-8")
      );
      expect(claudeJson.model).toBe("claude-3-7-sonnet");
      expect(claudeJson.subagents.worker.model).toBe("claude-3-5-haiku");

      const dshStale = path.join(env.workspaceDir, "dsh-stale");
      await copyFixture("dsh", "stale-profile", dshStale);
      const dshProfile = JSON.parse(
        fs.readFileSync(path.join(dshStale, ".agent-profile.json"), "utf-8")
      );
      expect(dshProfile.host_id).toBe("dsh");
      expect(dshProfile.single_model.model).toBe("dsh-unknown-model");
    } finally {
      await env.cleanup();
    }
  });
});
