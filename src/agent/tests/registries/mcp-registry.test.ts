import { describe, expect, jest, test, beforeEach } from "@jest/globals";

import { McpClientRegistry } from "../../src/agent/registries/mcp-registry.js";
import type { Mcp } from "../../src/agent/mcp/mcp.js";
import type { ToolDescriptor } from "../../src/agent/providers/provider.js";

/**
 * McpClientRegistry business logic.
 *
 * The registry is a thin name-keyed collection of mounted servers (`Mcp`):
 * `LocalMcp` (in-process) and `McpClient` (spawned stdio) are stored
 * interchangeably. It exposes a server by name and aggregates every server's
 * already-namespaced (`<server>__<tool>`) tool descriptors.
 */
describe("McpClientRegistry", () => {
  let registry: McpClientRegistry;

  beforeEach(() => {
    registry = new McpClientRegistry("/tmp/workspace");
  });

  /** A minimal `Mcp` whose `listTools()` returns the given namespaced descriptors. */
  function fakeMcp(name: string, tools: ToolDescriptor[]): Mcp {
    return {
      name,
      listTools: () => tools,
      callTool: jest.fn(async () => ({ isError: false, content: "ok" })),
      shutdown: jest.fn(async () => {}),
    };
  }

  test("returns sandboxRoot from constructor", () => {
    const customRoot = "/custom/workspace";
    const reg = new McpClientRegistry(customRoot);
    expect(reg.sandboxRoot).toBe(customRoot);
  });

  test("registerClient adds a server whose tools surface in listTools", () => {
    const tools: ToolDescriptor[] = [
      { name: "fsmcp__read_file", description: "read", inputSchema: { type: "object" } },
      { name: "fsmcp__write_file", description: "write", inputSchema: { type: "object" } },
    ];

    registry.registerClient(fakeMcp("fsmcp", tools));

    expect(registry.listTools()).toEqual(tools);
  });

  test("getClient returns the registered server by name", () => {
    const client = fakeMcp("fsmcp", []);
    registry.registerClient(client);

    expect(registry.getClient("fsmcp")).toBe(client);
  });

  test("getClient returns undefined for an unregistered name", () => {
    expect(registry.getClient("nope")).toBeUndefined();
  });

  test("registerClient is keyed by name — re-registering replaces the prior server", () => {
    registry.registerClient(
      fakeMcp("fsmcp", [{ name: "fsmcp__read_file", description: "v1", inputSchema: {} }])
    );
    const replacement = fakeMcp("fsmcp", [
      { name: "fsmcp__read_file", description: "v2", inputSchema: {} },
    ]);
    registry.registerClient(replacement);

    expect(registry.getClient("fsmcp")).toBe(replacement);
    expect(registry.listTools()).toHaveLength(1);
    expect(registry.listTools()[0].description).toBe("v2");
  });

  test("listTools aggregates tools from all registered servers", () => {
    registry.registerClient(
      fakeMcp("fsmcp", [{ name: "fsmcp__read_file", description: "read", inputSchema: { type: "object" } }])
    );
    registry.registerClient(
      fakeMcp("codemcp", [
        { name: "codemcp__search_code", description: "search", inputSchema: { type: "object" } },
      ])
    );

    const tools = registry.listTools();
    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.name)).toContain("fsmcp__read_file");
    expect(tools.map((t) => t.name)).toContain("codemcp__search_code");
  });

  test("multiple servers coexist and contribute all of their tools", () => {
    registry.registerClient(
      fakeMcp("fsmcp", [
        { name: "fsmcp__read_file", description: "read", inputSchema: { type: "object" } },
        { name: "fsmcp__write_file", description: "write", inputSchema: { type: "object" } },
      ])
    );
    registry.registerClient(
      fakeMcp("codemcp", [
        { name: "codemcp__search_code", description: "search", inputSchema: { type: "object" } },
      ])
    );

    const allTools = registry.listTools();
    expect(allTools).toHaveLength(3);
    expect(allTools.map((t) => t.name).sort()).toEqual(
      ["fsmcp__read_file", "fsmcp__write_file", "codemcp__search_code"].sort()
    );
  });

  test("listTools is empty with no registered servers", () => {
    expect(registry.listTools()).toEqual([]);
  });
});
