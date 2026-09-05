import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import {
  ProfileSchema,
  ExecutionConfigSchema,
  validateExecutionConfig,
  PreviewManager,
} from "../src/index.js";

const ajv = new Ajv({ allErrors: true, strictTypes: false });
addFormats(ajv);

const schemasDir = path.resolve(__dirname, "../schemas");
const profileSchema = JSON.parse(
  fs.readFileSync(path.join(schemasDir, "profile.schema.json"), "utf8")
);
const hostCapabilitiesSchema = JSON.parse(
  fs.readFileSync(path.join(schemasDir, "host-capabilities.schema.json"), "utf8")
);
const executionConfigSchema = JSON.parse(
  fs.readFileSync(path.join(schemasDir, "execution-config.schema.json"), "utf8")
);

const validateProfile = ajv.compile(profileSchema);
const validateHostCapabilities = ajv.compile(hostCapabilitiesSchema);
const validateExecutionConfigJson = ajv.compile(executionConfigSchema);

const candidatesFixturesDir = [
  process.env.SKILLS_FIXTURES_PATH,
  path.resolve(__dirname, "../../skills/skills/agent-config/tests/fixtures"),
  path.resolve(__dirname, "fixtures/skills"),
];
const skillsFixturesDir =
  candidatesFixturesDir.find((p) => Boolean(p && fs.existsSync(p))) ||
  path.resolve(__dirname, "fixtures/skills");

function loadSkillFixture(filename: string): any {
  const filePath = path.join(skillsFixturesDir, filename);
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

describe("Cross-Repo Skill × Companion Contract Acceptance", () => {
  describe("Layer 1 — Deterministic Contract Validation", () => {
    it("validates Skill single-model profile directly against profile.schema.json", () => {
      const singleProfile = loadSkillFixture("profile-single-model.json");
      const valid = validateProfile(singleProfile);
      expect(validateProfile.errors).toBeNull();
      expect(valid).toBe(true);

      // Also validates via Zod schema
      const parsed = ProfileSchema.parse(singleProfile);
      expect(parsed.model_mode).toBe("single");
      expect(parsed.single_model?.model).toBe("model-alpha");
    });

    it("validates Skill multi-model profile directly against profile.schema.json", () => {
      const multiProfile = loadSkillFixture("profile-multi-model.json");
      const valid = validateProfile(multiProfile);
      expect(validateProfile.errors).toBeNull();
      expect(valid).toBe(true);

      const parsed = ProfileSchema.parse(multiProfile);
      expect(parsed.model_mode).toBe("multi");
      expect(parsed.tiers?.routine.model).toBe("model-alpha");
      expect(parsed.tiers?.standard.model).toBe("model-beta");
      expect(parsed.tiers?.high.model).toBe("model-gamma");
      expect(parsed.tiers?.review.model).toBe("model-gamma");
    });

    it("validates all 4 primary Skill host fixtures directly against host-capabilities.schema.json", () => {
      const hostFiles = [
        "case-c-fixed-single-pass.json",
        "case-d-fixed-decomposed.json",
        "case-a-tiered-single-pass.json",
        "case-b-tiered-decomposed.json",
        "unranked-multiple-models.json",
        "missing-reasoning-control.json",
      ];

      for (const file of hostFiles) {
        const hostFixture = loadSkillFixture(file);
        const valid = validateHostCapabilities(hostFixture);
        expect(
          validateHostCapabilities.errors,
          `Failed on ${file}: ${JSON.stringify(validateHostCapabilities.errors)}`
        ).toBeNull();
        expect(valid).toBe(true);
      }
    });

    it("validates all 4 canonical ExecutionConfig fixtures (Cases A, B, C, D) directly against execution-config.schema.json (4/4 valid)", () => {
      const cases = ["case-a", "case-b", "case-c", "case-d"];

      for (const c of cases) {
        const fixture = loadSkillFixture(`execution-config-${c}.json`);
        const valid = validateExecutionConfigJson(fixture);
        expect(
          validateExecutionConfigJson.errors,
          `Failed on execution-config-${c}.json: ${JSON.stringify(
            validateExecutionConfigJson.errors
          )}`
        ).toBeNull();
        expect(valid).toBe(true);

        // Also passes Zod parser
        const parsed = ExecutionConfigSchema.parse(fixture);
        expect(parsed.readiness).toBe("executable");
      }
    });

    it("validates ExecutionConfigs against Profile and Host capabilities with companion validator", () => {
      const singleProfile = loadSkillFixture("profile-single-model.json");
      const multiProfile = loadSkillFixture("profile-multi-model.json");

      const hostCaseA = loadSkillFixture("case-c-fixed-single-pass.json");
      const hostCaseC = loadSkillFixture("case-a-tiered-single-pass.json");

      const execCaseA = loadSkillFixture("execution-config-case-a.json");
      const execCaseC = loadSkillFixture("execution-config-case-c.json");

      // Case A validation
      const resultCaseA = validateExecutionConfig(
        execCaseA,
        singleProfile,
        hostCaseA
      );
      expect(resultCaseA.valid).toBe(true);

      // Case C validation
      const resultCaseC = validateExecutionConfig(
        execCaseC,
        multiProfile,
        hostCaseC
      );
      expect(resultCaseC.valid).toBe(true);
    });

    it("generates frozen mutation previews with PreviewManager without error", async () => {
      const previewManager = new PreviewManager(15 * 60 * 1000);
      const execCaseA = loadSkillFixture("execution-config-case-a.json");
      const targetFile = "/tmp/test-config.toml";

      const preview = await previewManager.createPreview(
        "/tmp",
        {
          preview_id: "preview-case-a",
          mutation_targets: [targetFile],
          diff: "--- a/.codex/config.toml\n+++ b/.codex/config.toml\n@@ -1,1 +1,2 @@\n+[test]\n",
          files: [{ path: targetFile, content: "[test]\n" }],
        },
        execCaseA,
        {
          adapter_id: "codex",
          host_identity: "codex",
          scope: "project",
          target: targetFile,
        }
      );

      expect(preview.preview_id).toBeDefined();
      expect(preview.preview_hash).toBeDefined();
      const validation = await previewManager.validatePreview(preview.preview_id, "/tmp");
      expect(validation.valid).toBe(true);
    });
  });
});
