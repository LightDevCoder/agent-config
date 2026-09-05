import readline from "node:readline";
import { CANONICAL_TOOL_CONTRACTS, TOOL_NAMES } from "../../dist/contracts/index.js";

const scenarioArg = process.argv.find((a) => a.startsWith("--scenario="));
const scenario = scenarioArg ? scenarioArg.split("=")[1] : "canonical";

if (scenario === "unreachable") {
  // Exit immediately without responding to simulate unreachable process
  process.exit(1);
}

function buildCanonicalTools() {
  return TOOL_NAMES.map((name) => {
    const canonical = CANONICAL_TOOL_CONTRACTS[name];
    return {
      name: canonical.name,
      description: canonical.description,
      inputSchema: {
        type: "object",
        properties: Object.fromEntries(
          Object.entries(canonical.parameters).map(([k, v]) => [k, { type: v.type }])
        ),
        required: canonical.requiredParameters,
      },
      outputSchema: {
        type: "object",
        properties: Object.fromEntries(
          Object.entries(canonical.responseProperties).map(([k, v]) => [k, { type: v.type }])
        ),
        required: canonical.requiredResponseProperties,
      },
    };
  });
}

let tools = buildCanonicalTools();
let protocolVersion = 1;
let mcpTransportProtocolVersion = "2024-11-05";
let includeTransportProtocolVersion = true;

if (scenario === "unsupported-transport-protocol") {
  // Scenario: Wrong MCP transport protocol (SPEC §9 Scenario A)
  mcpTransportProtocolVersion = "deliberately-unsupported-mcp-version";
  protocolVersion = 1;
} else if (scenario === "missing-transport-protocol") {
  // Scenario: Missing MCP transport protocolVersion (SPEC §11)
  includeTransportProtocolVersion = false;
  protocolVersion = 1;
} else if (scenario === "invalid-transport-protocol") {
  // Scenario: Invalid MCP transport protocolVersion (SPEC §7)
  mcpTransportProtocolVersion = null;
  protocolVersion = 1;
} else if (scenario === "wrong-protocol") {
  // Scenario A: Agent Config protocol_version = 2
  protocolVersion = 2;
} else if (scenario === "missing-output-schema") {
  // Scenario B: One or more tools missing outputSchema
  tools = tools.map((t) => {
    if (t.name === "save_profile") {
      const copy = { ...t };
      delete copy.outputSchema;
      return copy;
    }
    return t;
  });
} else if (scenario === "invalid-output-schema") {
  // Scenario C: One tool has incompatible outputSchema property type
  tools = tools.map((t) => {
    if (t.name === "save_profile") {
      return {
        ...t,
        outputSchema: {
          ...t.outputSchema,
          properties: {
            ...t.outputSchema.properties,
            success: { type: "string" }, // expected boolean
          },
        },
      };
    }
    return t;
  });
} else if (scenario === "missing-tool") {
  // Scenario D: 7 / 8 tools (omit reset_profile)
  tools = tools.filter((t) => t.name !== "reset_profile");
} else if (scenario === "canonical") {
  // Scenario F: Fully compatible companion
  protocolVersion = 1;
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

rl.on("line", (line) => {
  if (!line.trim()) return;
  try {
    const msg = JSON.parse(line.trim());
    if (msg.method === "initialize") {
      const initResult = {
        capabilities: { tools: {} },
        serverInfo: { name: "fake-companion", version: "1.0.0" },
      };
      if (includeTransportProtocolVersion) {
        initResult.protocolVersion = mcpTransportProtocolVersion;
      }
      const resp = {
        jsonrpc: "2.0",
        id: msg.id,
        result: initResult,
      };
      process.stdout.write(JSON.stringify(resp) + "\n");
    } else if (msg.method === "notifications/initialized") {
      // Notification, no response
    } else if (msg.method === "tools/list") {
      const resp = {
        jsonrpc: "2.0",
        id: msg.id,
        result: { tools },
      };
      process.stdout.write(JSON.stringify(resp) + "\n");
    } else if (msg.method === "tools/call") {
      if (msg.params?.name === "get_setup_status") {
        const resp = {
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  configured: true,
                  protocol_version: protocolVersion,
                  profile_version: null,
                  host_id: "fake-companion-host",
                  adapter_id: "fake-companion-adapter",
                  scope: "project",
                  stale: false,
                  stale_reasons: [],
                  companion_registered: true,
                }),
              },
            ],
          },
        };
        process.stdout.write(JSON.stringify(resp) + "\n");
      } else {
        const resp = {
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            content: [{ type: "text", text: JSON.stringify({ success: true }) }],
          },
        };
        process.stdout.write(JSON.stringify(resp) + "\n");
      }
    }
  } catch {
    // ignore
  }
});
