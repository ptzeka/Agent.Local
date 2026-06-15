import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpToolServer, type ServerTool } from "@agent-local/mcp/tool-server";

// the dependency bundle codemcp injects into every handler; here a marker stands in for the
// db readers/embedder so the test can prove deps reach the handler without real infrastructure.
interface Deps {
  marker: string;
}

const tools: ServerTool<Deps>[] = [
  {
    name: "echo",
    description: "echo the message back, prefixed with the injected marker",
    inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
    handler: async (input, deps) => `${deps.marker}:${(input as { message: string }).message}`,
  },
  {
    name: "boom",
    description: "always throws — exercises error shaping",
    inputSchema: { type: "object" },
    handler: async () => {
      throw new Error("kaboom");
    },
  },
];

// end-to-end over a real in-memory MCP transport pair: a genuine Client speaks JSON-RPC to the
// McpToolServer codemcp is built on, so list/dispatch/error-shaping are tested as the SDK sees them.
describe("codemcp tool server", () => {
  let server: McpToolServer<Deps>;
  let client: Client;
  let shutdownCount = 0;

  beforeAll(async () => {
    server = new McpToolServer<Deps>({
      name: "codemcp-test",
      version: "0.0.0",
      tools,
      deps: { marker: "M" },
      onShutdown: async () => {
        shutdownCount += 1;
      },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(clientTransport);
  });

  afterAll(async () => {
    await client.close();
    await server.dispose();
  });

  test("advertises tools, injects deps on call, and shapes unknown-tool and handler errors", async () => {
    const listed = await client.listTools();
    expect(listed.tools.map((t) => t.name).sort()).toEqual(["boom", "echo"]);
    const echo = listed.tools.find((t) => t.name === "echo");
    expect(echo?.inputSchema).toMatchObject({ properties: { message: { type: "string" } } });

    const ok = await client.callTool({ name: "echo", arguments: { message: "hi" } });
    expect(ok.isError).toBeFalsy();
    expect(ok.content).toMatchObject([{ type: "text", text: "M:hi" }]);

    const unknown = await client.callTool({ name: "nope", arguments: {} });
    expect(unknown.isError).toBe(true);
    expect((unknown.content as Array<{ text: string }>)[0].text).toContain("unknown tool: nope");

    const thrown = await client.callTool({ name: "boom", arguments: {} });
    expect(thrown.isError).toBe(true);
    expect((thrown.content as Array<{ text: string }>)[0].text).toBe("boom failed: kaboom");
  });

  test("dispose is idempotent — cleanup runs exactly once across repeated calls", async () => {
    shutdownCount = 0;
    await server.dispose();
    await server.dispose();
    expect(shutdownCount).toBe(1);
  });
});
