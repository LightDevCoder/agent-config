import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server/index.js";
import { ProfileStore } from "../src/profile/store.js";
import { AdapterRegistry } from "../src/adapters/registry.js";
import { PreviewManager } from "../src/server/preview.js";
import {
  PROTOCOL_VERSION,
  PROFILE_VERSION,
  TOOL_NAMES,
  CANONICAL_TOOL_CONTRACTS,
} from "../src/contracts/index.js";
import {
  validatePreviewAgainstJsonSchema,
  validateApplyAgainstJsonSchema,
  validateValidationAgainstJsonSchema,
  validateCompanionContractAgainstJsonSchema,
} from "../src/profile/validator.js";
import { ExecutionConfig, Profile } from "../src/profile/schema.js";

describe("SPEC §67: Real Contract Coherence Automated Verification", () => {
  let tempDir: string;
  let workspaceDir: string;
  let client: Client;
  let server: ReturnType<typeof createServer>;
  let profileStore: ProfileStore;
  let adapterRegistry: AdapterRegistry;
  let previewManager: PreviewManager;

  const validExecutionConfig: ExecutionConfig = {
    task_shape: "single-pass",
    model_mode: "single",
    readiness: "executable",
    topology: {
      type: "single-session",
      concurrency: 1,
    },
    execution: {
      model: "test-model",
      effort: "high",
      effort_policy: "highest-supported",
      context: "current-session",
    },
    review: {
      strategy: "self-check",
      model: "test-model",
      effort: "high",
      context: "current-session",
    },
  };

  const sampleProfile: Profile = {
    profile_version: PROFILE_VERSION,
    host: {
      id: "generic",
      adapter: "generic",
    },
    scope: {
      type: "project",
      workspace: "/dummy/path",
    },
    model_mode: "single",
    models: {
      available: ["test-model"],
    },
    single_model: {
      model: "test-model",
      execution_effort: { policy: "highest-supported" },
    },
  };

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-config-coherence-test-"));
    workspaceDir = path.join(tempDir, "workspace");
    await fsp.mkdir(workspaceDir, { recursive: true });

    profileStore = new ProfileStore({ baseDir: path.join(tempDir, "profiles") });
    adapterRegistry = new AdapterRegistry();
    previewManager = new PreviewManager();

    server = createServer({ profileStore, adapterRegistry, previewManager });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "coherence-verifier", version: "1.0.0" });
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
    if (fs.existsSync(tempDir)) {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("verifies protocol version constant is fixed to 1", () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(PROFILE_VERSION).toBe(1);
  });

  it("verifies registered tool names exactly match all 8 canonical tool names", async () => {
    const listResult = await client.listTools();
    const registeredNames = listResult.tools.map((t) => t.name).sort();
    const expectedNames = [...TOOL_NAMES].sort();

    expect(registeredNames).toEqual(expectedNames);
    expect(registeredNames).toHaveLength(8);
  });

  it("verifies registered input parameter schemas match canonical contracts", async () => {
    const listResult = await client.listTools();

    for (const tool of listResult.tools) {
      const canonicalContract = CANONICAL_TOOL_CONTRACTS[tool.name as keyof typeof CANONICAL_TOOL_CONTRACTS];
      expect(canonicalContract, `Tool '${tool.name}' must have a canonical contract`).toBeDefined();

      const inputSchema = tool.inputSchema;
      expect(inputSchema.type).toBe("object");

      const registeredProps = inputSchema.properties || {};
      const expectedParams = canonicalContract.parameters;

      // Check all canonical parameters exist in registered tool schema
      for (const [paramName, paramSpec] of Object.entries(expectedParams)) {
        const registeredParam = registeredProps[paramName];
        expect(
          registeredParam,
          `Tool '${tool.name}' inputSchema must define parameter '${paramName}'`
        ).toBeDefined();

        if (paramSpec.type === "object") {
          expect(registeredParam.type).toBe("object");
        } else if (paramSpec.type === "string") {
          expect(registeredParam.type).toBe("string");
        }

        if (paramSpec.enum) {
          expect(registeredParam.enum).toEqual(paramSpec.enum);
        }
      }

      // Check required fields
      const registeredRequired = inputSchema.required || [];
      const expectedRequired = canonicalContract.requiredParameters;
      expect(
        registeredRequired.sort(),
        `Tool '${tool.name}' required parameters mismatch`
      ).toEqual(expectedRequired.sort());
    }
  });

  it("verifies get_setup_status returns protocol_version: 1 and coherent fields in unconfigured state", async () => {
    const res = await client.callTool({
      name: "get_setup_status",
      arguments: { workspace: workspaceDir },
    });
    expect(res.isError).toBeFalsy();

    const data = JSON.parse((res.content[0] as { type: string; text: string }).text);
    expect(data.configured).toBe(false);
    expect(data.protocol_version).toBe(1);
    expect(data.profile_version).toBeNull();
    expect(data.stale).toBe(false);
    expect(data.host_id).toBeDefined();
    expect(Array.isArray(data.stale_reasons)).toBe(true);
  });

  it("verifies get_setup_status returns protocol_version: 1 and coherent fields in configured state", async () => {
    const profile = {
      ...sampleProfile,
      scope: { type: "project" as const, workspace: workspaceDir },
    };
    await profileStore.saveProfile(profile);

    const res = await client.callTool({
      name: "get_setup_status",
      arguments: { workspace: workspaceDir },
    });
    expect(res.isError).toBeFalsy();

    const data = JSON.parse((res.content[0] as { type: string; text: string }).text);
    expect(data.configured).toBe(true);
    expect(data.protocol_version).toBe(1);
    expect(data.profile_version).toBe(1);
    expect(data.stale).toBe(false);
    expect(data.host_id).toBe("generic");
    expect(data.adapter_id).toBe("generic");
    expect(data.scope).toBe("project");
  });

  it("verifies scope representation coherence ('project' | 'global') across tools", async () => {
    const listResult = await client.listTools();
    const scopeTools = ["get_setup_status", "get_profile", "reset_profile"];

    for (const toolName of scopeTools) {
      const tool = listResult.tools.find((t) => t.name === toolName);
      expect(tool, `Tool '${toolName}' must be registered`).toBeDefined();
      const scopeProp = tool!.inputSchema.properties?.scope;
      expect(scopeProp, `Tool '${toolName}' must define scope parameter`).toBeDefined();
      expect(scopeProp.enum).toEqual(["project", "global"]);
    }
  });

  it("verifies preview identity fields coherence (preview_id, preview_hash, diff, expires_at, target, baseline_hash)", async () => {
    const res = await client.callTool({
      name: "preview_configuration",
      arguments: { config: validExecutionConfig, workspace: workspaceDir },
    });
    expect(res.isError).toBeFalsy();

    const data = JSON.parse((res.content[0] as { type: string; text: string }).text);

    // Validate directly against canonical preview.schema.json
    const schemaValidation = validatePreviewAgainstJsonSchema(data);
    expect(schemaValidation.valid, `Preview result must satisfy preview.schema.json: ${schemaValidation.errors?.join(", ")}`).toBe(true);

    // Validate specific required identity fields
    expect(typeof data.preview_id).toBe("string");
    expect(data.preview_id.length).toBeGreaterThan(0);
    expect(data.preview_hash).toMatch(/^sha256-[a-f0-9]+$/);
    expect(typeof data.diff).toBe("string");
    expect(typeof data.expires_at).toBe("string");
    expect(typeof data.target).toBe("string");
    expect(data.baseline_hash === null || typeof data.baseline_hash === "string").toBe(true);
    expect(Array.isArray(data.mutation_targets)).toBe(true);
  });

  it("verifies apply identity fields coherence (success, preview_id, applied_targets, target, baseline_hash, message)", async () => {
    const previewRes = await client.callTool({
      name: "preview_configuration",
      arguments: { config: validExecutionConfig, workspace: workspaceDir },
    });
    const previewData = JSON.parse((previewRes.content[0] as { type: string; text: string }).text);

    const applyRes = await client.callTool({
      name: "apply_configuration",
      arguments: { preview_id: previewData.preview_id, workspace: workspaceDir },
    });
    expect(applyRes.isError).toBeFalsy();

    const applyData = JSON.parse((applyRes.content[0] as { type: string; text: string }).text);

    // Validate directly against canonical apply.schema.json
    const schemaValidation = validateApplyAgainstJsonSchema(applyData);
    expect(schemaValidation.valid, `Apply result must satisfy apply.schema.json: ${schemaValidation.errors?.join(", ")}`).toBe(true);

    expect(applyData.success).toBe(true);
    expect(applyData.preview_id).toBe(previewData.preview_id);
    expect(Array.isArray(applyData.applied_targets)).toBe(true);
    expect(typeof applyData.target).toBe("string");
    expect(applyData.baseline_hash === null || typeof applyData.baseline_hash === "string").toBe(true);
    expect(typeof applyData.message).toBe("string");
  });

  it("verifies fail-closed rejection on malformed preview input (no guessing, no heuristics)", async () => {
    const malformedConfigs = [
      {},
      { model: "gpt-4" },
      { task_shape: "single-pass" }, // Missing model_mode, readiness, topology, execution, review
      {
        task_shape: "single-pass",
        model_mode: "single",
        readiness: "executable",
        topology: { type: "single-session", concurrency: 1 },
        // Missing execution and review
      },
    ];

    for (const badConfig of malformedConfigs) {
      const res = await client.callTool({
        name: "preview_configuration",
        arguments: { config: badConfig, workspace: workspaceDir },
      });

      expect(res.isError, `Malformed config ${JSON.stringify(badConfig)} must be rejected fail-closed`).toBe(true);
      const errText = (res.content[0] as { type: string; text: string }).text;
      expect(errText).toContain("preview_configuration error");
    }
  });

  it("verifies companion contract canonical definition satisfies companion-contract.schema.json", () => {
    const contractDoc = {
      protocol_version: PROTOCOL_VERSION,
      profile_version: PROFILE_VERSION,
      tools: Object.fromEntries(
        Object.entries(CANONICAL_TOOL_CONTRACTS).map(([name, def]) => [
          name,
          {
            name: def.name,
            description: def.description,
            request: {
              type: "object",
              properties: Object.fromEntries(
                Object.entries(def.parameters).map(([pName, pSpec]) => [
                  pName,
                  { type: pSpec.type, ...(pSpec.enum ? { enum: pSpec.enum } : {}) },
                ])
              ),
              required: def.requiredParameters,
            },
            response: {
              type: "object",
              properties: Object.fromEntries(
                Object.entries(def.responseProperties).map(([rName, rSpec]) => [
                  rName,
                  { type: rSpec.type },
                ])
              ),
              required: def.requiredResponseProperties,
            },
          },
        ])
      ),
      errors: {
        type: "object",
        properties: {
          isError: true,
          content: [{ type: "text", text: "error" }],
        },
      },
    };

    const validation = validateCompanionContractAgainstJsonSchema(contractDoc);
    expect(validation.valid, `Contract document must satisfy companion-contract.schema.json: ${validation.errors?.join(", ")}`).toBe(true);
  });
});
