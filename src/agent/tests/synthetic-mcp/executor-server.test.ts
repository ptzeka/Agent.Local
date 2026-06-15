import { describe, expect, test } from "@jest/globals";

import { ExecutorLocalMcp } from "../../src/agent/synthetic-mcp/executor-server.js";
import type { McpClientRegistry } from "../../src/agent/registries/mcp-registry.js";
import type { ToolDescriptor } from "@agent-local/mcp/tooldescriptor";
import { makeContext } from "../middleware/context.js";

// the "tool" property must enumerate the executor role's live tool names (from the mounted servers'
// advertisement registry) as both a strict schema enum and prose, so the orchestrator can only pick
// names the executor can actually run
describe("ExecutorLocalMcp.listTools", () => {
  // A fake advertisement registry that just replays the given descriptors;
  // unmounted servers (e.g. codemcp) are simply absent from the list.
  const makeExecutorServers = (tools: Partial<ToolDescriptor>[]) =>
    ({ listTools: () => tools as ToolDescriptor[] }) as unknown as McpClientRegistry;

  test("enumerates the executor's mounted tools as enum and description", () => {
    const executorServers = makeExecutorServers([
      { name: "fsmcp__write_file" },
      { name: "fsmcp__edit_file" },
    ]);

    const [descriptor] = new ExecutorLocalMcp(makeContext({}), executorServers).listTools();

    expect(descriptor.name).toBe("executor__dispatch");
    const toolProperty = (descriptor.inputSchema as { properties: { tool: { enum?: string[] } } })
      .properties.tool;
    expect(toolProperty.enum).toEqual(["fsmcp__write_file", "fsmcp__edit_file"]);
    expect(descriptor.description).toContain("fsmcp__write_file");
    expect(descriptor.description).toContain("fsmcp__edit_file");
    // The executor server itself is never a dispatch target.
    expect(descriptor.description).not.toContain("executor__dispatch\n");
  });

  test("omits the enum when no executor tools are mounted", () => {
    const [descriptor] = new ExecutorLocalMcp(makeContext({}), makeExecutorServers([])).listTools();

    const toolProperty = (descriptor.inputSchema as { properties: { tool: { enum?: string[] } } })
      .properties.tool;
    expect(toolProperty.enum).toBeUndefined();
    expect(descriptor.description).toContain("No executor-side tools are currently mounted");
  });

  test("advertises executor__list_tools alongside dispatch", () => {
    const executorServers = makeExecutorServers([{ name: "fsmcp__write_file" }]);

    const tools = new ExecutorLocalMcp(makeContext({}), executorServers).listTools();

    expect(tools.map((tool) => tool.name)).toEqual(["executor__dispatch", "executor__list_tools"]);
  });
});

describe("ExecutorLocalMcp.callTool list_tools", () => {
  test("returns the executor's tool descriptors as JSON without dispatching", async () => {
    const executorServers = {
      listTools: () => [{ name: "fsmcp__write_file", description: "write", inputSchema: {} }],
    } as unknown as McpClientRegistry;

    const result = await new ExecutorLocalMcp(makeContext({}), executorServers).callTool(
      "list_tools",
      {}
    );

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content) as { name: string }[];
    expect(parsed.map((tool) => tool.name)).toEqual(["fsmcp__write_file"]);
  });
});
