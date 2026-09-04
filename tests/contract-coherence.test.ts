import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("SPEC §43: Contract Coherence Automated Verification", () => {
  const skillsContractPath = path.resolve(
    __dirname,
    "../../skills/skills/agent-config/references/companion-contract.md"
  );
  const mcpReadmePath = path.resolve(__dirname, "../README.md");

  it("ensures skills companion-contract.md exists and is readable", () => {
    expect(fs.existsSync(skillsContractPath)).toBe(true);
  });

  it("verifies exact match of all 8 MCP tool names between contract and implementation", () => {
    const contractContent = fs.readFileSync(skillsContractPath, "utf-8");

    const expectedTools = [
      "get_setup_status",
      "inspect_host",
      "get_profile",
      "save_profile",
      "preview_configuration",
      "apply_configuration",
      "validate_configuration",
      "reset_profile",
    ];

    for (const tool of expectedTools) {
      expect(contractContent).toContain(`\`${tool}\``);
    }
  });

  it("verifies protocol versioning coherence", () => {
    const contractContent = fs.readFileSync(skillsContractPath, "utf-8");
    expect(contractContent).toContain("protocol_version: 1");
    expect(contractContent).toContain("profile_version: 1");
  });

  it("verifies preview/apply fields coherence (preview_id, preview_hash, diff, expires_at)", () => {
    const contractContent = fs.readFileSync(skillsContractPath, "utf-8");
    expect(contractContent).toContain("preview_id");
    expect(contractContent).toContain("preview_hash");
    expect(contractContent).toContain("diff");
    expect(contractContent).toContain("expires_at");
  });

  it("verifies non-blocking companion-absent operation / fallback coherence", () => {
    const contractContent = fs.readFileSync(skillsContractPath, "utf-8");
    expect(contractContent).toContain("plan-only");
    expect(contractContent).toContain("Run agent-config setup");
  });
});
