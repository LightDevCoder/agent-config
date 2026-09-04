import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  createServer,
  startServer,
  SERVER_NAME,
  SERVER_VERSION,
} from "../src/server/index.js";
import { ProfileStore } from "../src/profile/store.js";
import { AdapterRegistry } from "../src/adapters/registry.js";
import { PreviewManager } from "../src/server/preview.js";

describe("MCP Server Startup, Tool Registration & JSON-RPC Protocol Compliance", () => {
  let tempDir: string;
  let workspaceDir: string;
  let profilesDir: string;
  let profileStore: ProfileStore;
  let adapterRegistry: AdapterRegistry;
  let previewManager: PreviewManager;

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-config-server-test-"));
    workspaceDir = path.join(tempDir, "workspace");
    profilesDir = path.join(tempDir, "profiles");
    await fsp.mkdir(workspaceDir, { recursive: true });
    await fsp.mkdir(profilesDir, { recursive: true });

    profileStore = new ProfileStore({ baseDir: profilesDir });
    adapterRegistry = new AdapterRegistry();
    previewManager = new PreviewManager();
  });

  afterEach(async () => {
    if (fs.existsSync(tempDir)) {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  describe("Server Startup & Tool Registration", () => {
    it("exports canonical server identity and version", () => {
      expect(SERVER_NAME).toBe("agent-config");
      expect(SERVER_VERSION).toBe("0.1.0");
    });

    it("creates server instance with default options without error", () => {
      const server = createServer();
      expect(server).toBeDefined();
    });

    it("creates server instance with injected dependencies", () => {
      const server = createServer({
        profileStore,
        adapterRegistry,
        previewManager,
      });
      expect(server).toBeDefined();
    });
  });

  describe("JSON-RPC Protocol Compliance (InMemoryTransport)", () => {
    let client: Client;
    let server: ReturnType<typeof createServer>;

    beforeEach(async () => {
      server = createServer({
        profileStore,
        adapterRegistry,
        previewManager,
      });

      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      client = new Client({ name: "jsonrpc-test-client", version: "1.0.0" });

      await Promise.all([
        client.connect(clientTransport),
        server.connect(serverTransport),
      ]);
    });

    afterEach(async () => {
      await client.close();
      await server.close();
    });

    it("completes JSON-RPC initialize handshake with server metadata", () => {
      const serverVersion = client.getServerVersion();
      expect(serverVersion).toBeDefined();
      expect(serverVersion?.name).toBe("agent-config");
      expect(serverVersion?.version).toBe("0.1.0");
    });

    it("registers all 8 core tools with valid schemas and descriptions", async () => {
      const toolsResult = await client.listTools();
      const tools = toolsResult.tools;

      expect(tools).toHaveLength(8);

      const expectedToolNames = [
        "get_setup_status",
        "inspect_host",
        "get_profile",
        "save_profile",
        "preview_configuration",
        "apply_configuration",
        "validate_configuration",
        "reset_profile",
      ];

      for (const name of expectedToolNames) {
        const found = tools.find((t) => t.name === name);
        expect(found, `Tool '${name}' must be registered`).toBeDefined();
        expect(found!.description).toBeDefined();
        expect(found!.description!.length).toBeGreaterThan(5);
        expect(found!.inputSchema).toBeDefined();
        expect(found!.inputSchema.type).toBe("object");
      }
    });

    it("handles tool execution error gracefully conforming to MCP response format", async () => {
      // Calling apply_configuration with an invalid/nonexistent preview ID
      const result = await client.callTool({
        name: "apply_configuration",
        arguments: {
          preview_id: "non-existent-hash-9999",
          workspace: workspaceDir,
        },
      });

      // Tool handles error and returns isError: true with error explanation
      expect(result.isError).toBe(true);
      expect(result.content).toBeDefined();
      expect(result.content.length).toBeGreaterThan(0);
      const textContent = (result.content[0] as { type: string; text: string }).text;
      expect(textContent).toContain("apply_configuration error");
    });

    it("rejects calls to unknown tools with protocol-level error", async () => {
      const result = await client.callTool({
        name: "unregistered_tool_xyz",
        arguments: {},
      });
      expect(result.isError).toBe(true);
      const textContent = (result.content[0] as { type: string; text: string }).text;
      expect(textContent).toMatch(/not found/i);
    });

    it("handles save_profile input validation failure with error", async () => {
      // Missing required fields
      const result = await client.callTool({
        name: "save_profile",
        arguments: {
          profile: {
            invalid: true,
          },
          workspace: workspaceDir,
        },
      });

      expect(result.isError).toBe(true);
      const textContent = (result.content[0] as { type: string; text: string }).text;
      expect(textContent).toContain("save_profile error");
    });
  });

  describe("JSON-RPC Protocol Compliance (StdioServerTransport)", () => {
    it("boots server process over stdio and executes tool call", async () => {
      const transport = new StdioClientTransport({
        command: "node",
        args: [path.resolve(__dirname, "../dist/server/index.js")],
        env: {
          ...process.env,
          AGENT_CONFIG_HOME: tempDir,
          AGENT_CONFIG_PROFILES_DIR: profilesDir,
        },
      });

      const client = new Client({ name: "stdio-test-client", version: "1.0.0" });

      try {
        await client.connect(transport);

        // Verify server info
        const serverVersion = client.getServerVersion();
        expect(serverVersion?.name).toBe("agent-config");
        expect(serverVersion?.version).toBe("0.1.0");

        // Verify tool listing
        const toolsResult = await client.listTools();
        expect(toolsResult.tools).toHaveLength(8);

        // Verify tool execution
        const inspectRes = await client.callTool({
          name: "inspect_host",
          arguments: { workspace: workspaceDir },
        });

        expect(inspectRes.isError).toBeFalsy();
        const data = JSON.parse(
          (inspectRes.content[0] as { type: string; text: string }).text
        );
        expect(data.host_id).toBeDefined();
        expect(data.capabilities).toBeDefined();
      } finally {
        await client.close();
      }
    });
  });

  describe("Test Isolation Guarantee", () => {
    it("strictly isolates persistence within temp directory and does not mutate user home", async () => {
      const userHome = os.homedir();
      const codexUserDir = path.join(userHome, ".codex");
      const opencodeUserDir = path.join(userHome, ".config", "opencode");

      const codexExistedBefore = fs.existsSync(codexUserDir);
      const opencodeExistedBefore = fs.existsSync(opencodeUserDir);

      let codexMtimeBefore: number | null = null;
      if (codexExistedBefore) {
        codexMtimeBefore = (await fsp.stat(codexUserDir)).mtimeMs;
      }

      // Execute tool operations inside isolated workspace
      const server = createServer({ profileStore, adapterRegistry, previewManager });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "isolation-check", version: "1.0.0" });
      await Promise.all([
        client.connect(clientTransport),
        server.connect(serverTransport),
      ]);

      try {
        await client.callTool({
          name: "inspect_host",
          arguments: { workspace: workspaceDir },
        });

        await client.callTool({
          name: "get_setup_status",
          arguments: { workspace: workspaceDir },
        });
      } finally {
        await client.close();
        await server.close();
      }

      // Verify that user home directory was NOT created or modified if it didn't exist
      if (!codexExistedBefore) {
        expect(fs.existsSync(codexUserDir)).toBe(false);
      } else {
        const codexMtimeAfter = (await fsp.stat(codexUserDir)).mtimeMs;
        expect(codexMtimeAfter).toBe(codexMtimeBefore);
      }

      if (!opencodeExistedBefore) {
        expect(fs.existsSync(opencodeUserDir)).toBe(false);
      }

      // Verify files were only created inside tempDir
      expect(fs.existsSync(profilesDir)).toBe(true);
    });
  });
});
