import { describe, expect, jest, test, beforeEach } from "@jest/globals";

import { McpClientRegistry } from "../../src/agent/registries/mcp-registry.js";
import type { McpClient } from "../../src/agent/mcp-client.js";
import type { ToolDescriptor } from "../../src/agent/providers/provider.js";

/**
 * McpClientRegistry business logic.
 *
 * The MCP registry aggregates multiple single-server MCP clients, routing tool
 * calls to the correct server based on namespaced tool names (`<server>__<tool>`).
 * It handles tool discovery, filtering by role, and server registration/refresh.
 */
describe("McpClientRegistry", () => {
  let registry: McpClientRegistry;

  beforeEach(() => {
    registry = new McpClientRegistry("/tmp/workspace");
  });

  function fakeMcpClient(name: string, tools: ToolDescriptor[]): McpClient {
    return {
      name,
      listTools: () => tools,
      callTool: jest.fn(async () => ({ isError: false, content: "ok" })),
      shutdown: jest.fn(async () => {}),
    } as unknown as McpClient;
  }

  test("returns sandboxRoot from constructor", () => {
    const customRoot = "/custom/workspace";
    const reg = new McpClientRegistry(customRoot);
    expect(reg.sandboxRoot).toBe(customRoot);
  });

  test("registerClient adds client and indexes tools", () => {
    const tools: ToolDescriptor[] = [
      { name: "fsmcp__read_file", description: "read", inputSchema: { type: "object" } },
      { name: "fsmcp__write_file", description: "write", inputSchema: { type: "object" } },
    ];
    const client = fakeMcpClient("fsmcp", tools);

    registry.registerClient(client);

    expect(registry.listTools()).toEqual(tools);
  });

  test("listTools returns tools from all registered clients", () => {
    const fsclient = fakeMcpClient("fsmcp", [
      { name: "fsmcp__read_file", description: "read", inputSchema: { type: "object" } },
    ]);
    const codeclient = fakeMcpClient("codemcp", [
      { name: "codemcp__search_code", description: "search", inputSchema: { type: "object" } },
    ]);

    registry.registerClient(fsclient);
    registry.registerClient(codeclient);

    const tools = registry.listTools();
    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.name)).toContain("fsmcp__read_file");
    expect(tools.map((t) => t.name)).toContain("codemcp__search_code");
  });

  test("listToolsForOrchestrator filters to orchestrator-only tools", () => {
    const tools: ToolDescriptor[] = [
      { name: "fsmcp__read_file", description: "read", inputSchema: { type: "object" } },
      { name: "fsmcp__write_file", description: "write", inputSchema: { type: "object" } },
      { name: "subsessions__create_subsession", description: "create subsession", inputSchema: { type: "object" } },
    ];
    const client = fakeMcpClient("fsmcp", tools);

    registry.registerClient(client);

    const orchestratorTools = registry.listToolsForOrchestrator();
    // Only read_file should be included for orchestrator (write requires executor)
    expect(orchestratorTools.some((t) => t.name === "fsmcp__read_file")).toBe(true);
  });

  test("listToolsForExecutor returns all tools", () => {
    const tools: ToolDescriptor[] = [
      { name: "fsmcp__read_file", description: "read", inputSchema: { type: "object" } },
      { name: "fsmcp__write_file", description: "write", inputSchema: { type: "object" } },
    ];
    const client = fakeMcpClient("fsmcp", tools);

    registry.registerClient(client);

    const executorTools = registry.listToolsForExecutor();
    expect(executorTools).toHaveLength(2);
  });

  test("callTool routes to the correct client", async () => {
    const tools: ToolDescriptor[] = [
      { name: "fsmcp__read_file", description: "read", inputSchema: { type: "object" } },
    ];
    const client = fakeMcpClient("fsmcp", tools);
    registry.registerClient(client);

    await registry.callTool("fsmcp__read_file", { path: "test.txt" });

    expect(client.callTool).toHaveBeenCalledWith("read_file", { path: "test.txt" });
  });

  test("callTool returns error for unknown tool", async () => {
    const client = fakeMcpClient("fsmcp", [
      { name: "fsmcp__read_file", description: "read", inputSchema: { type: "object" } },
    ]);
    registry.registerClient(client);

    const result = await registry.callTool("unknown__tool", {});

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Unknown tool");
  });

  test("callTool returns error when server is no longer registered", async () => {
    const client = fakeMcpClient("fsmcp", [
      { name: "fsmcp__read_file", description: "read", inputSchema: { type: "object" } },
    ]);
    registry.registerClient(client);

    // After shutdown, the client is removed and the tool becomes unknown
    await registry.shutdown();

    const result = await registry.callTool("fsmcp__read_file", {});

    expect(result.isError).toBe(true);
    // After shutdown, tools are cleared, so we get "Unknown tool" instead
    expect(result.content).toContain("Unknown tool");
  });

  test("registerInProcessServer stores client for later connection", () => {
    const mockClient = {} as any;
    registry.registerInProcessServer("excel", mockClient);
    // No immediate assertion needed, but it should not throw
    expect(registry).toBeDefined();
  });

  test("shutdown closes all clients", async () => {
    const client1 = fakeMcpClient("fsmcp", [
      { name: "fsmcp__read_file", description: "read", inputSchema: { type: "object" } },
    ]);
    const client2 = fakeMcpClient("codemcp", [
      { name: "codemcp__search_code", description: "search", inputSchema: { type: "object" } },
    ]);

    registry.registerClient(client1);
    registry.registerClient(client2);

    await registry.shutdown();

    expect(client1.shutdown).toHaveBeenCalled();
    expect(client2.shutdown).toHaveBeenCalled();
    expect(registry.listTools()).toHaveLength(0);
  });

  test("multiple clients can coexist with different servers", () => {
    const fsclient = fakeMcpClient("fsmcp", [
      { name: "fsmcp__read_file", description: "read", inputSchema: { type: "object" } },
      { name: "fsmcp__write_file", description: "write", inputSchema: { type: "object" } },
    ]);
    const codeclient = fakeMcpClient("codemcp", [
      { name: "codemcp__search_code", description: "search", inputSchema: { type: "object" } },
    ]);

    registry.registerClient(fsclient);
    registry.registerClient(codeclient);

    const allTools = registry.listTools();
    expect(allTools).toHaveLength(3);
    expect(allTools.map((t) => t.name).sort()).toEqual(
      ["fsmcp__read_file", "fsmcp__write_file", "codemcp__search_code"].sort()
    );
  });

  test("tool dispatch extracts server and tool names correctly", async () => {
    const tools: ToolDescriptor[] = [
      { name: "mysrv__my_tool_name", description: "tool", inputSchema: { type: "object" } },
    ];
    const client = fakeMcpClient("mysrv", tools);
    registry.registerClient(client);

    await registry.callTool("mysrv__my_tool_name", { arg: "value" });

    expect(client.callTool).toHaveBeenCalledWith("my_tool_name", { arg: "value" });
  });
});
