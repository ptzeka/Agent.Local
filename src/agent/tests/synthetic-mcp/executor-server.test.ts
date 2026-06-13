import { describe, expect, test } from "@jest/globals";

import { ExecutorLocalMcp } from "../../src/agent/synthetic-mcp/executor-server.js";
import type { ModelRegistry } from "../../src/agent/registries/index.js";
import type { McpClientRegistry } from "../../src/agent/registries/mcp-registry.js";
import { makeContext } from "../middleware/context.js";

/**
 * ExecutorLocalMcp dispatch descriptor.
 *
 * The "tool" property must enumerate the executor role's live tool names —
 * resolved per listTools() call from the role's MCP servers — both as a strict
 * schema enum and in the prose description, so the orchestrator can only pick
 * names the executor can actually run.
 */
describe("ExecutorLocalMcp.listTools", () => {
  const makeRegistries = () => {
    const modelsRegistry = {
      getValidMcpServersForRole: (role: string) =>
        role === "executor" ? ["fsmcp", "codemcp", "executor"] : [],
    } as unknown as ModelRegistry;

    const clients: Record<string, { listTools: () => { name: string }[] } | undefined> = {
      fsmcp: {
        listTools: () => [
          { name: "fsmcp__write_file" },
          { name: "fsmcp__edit_file" },
        ],
      },
      // codemcp declared in models.json but not mounted — must drop out.
      codemcp: undefined,
    };
    const mcpRegistry = {
      getClient: (name: string) => clients[name],
    } as unknown as McpClientRegistry;

    return { modelsRegistry, mcpRegistry };
  };

  test("enumerates the executor role's mounted tools as enum and description", () => {
    const { modelsRegistry, mcpRegistry } = makeRegistries();
    const ctx = makeContext({ modelsRegistry, mcpRegistry });

    const [descriptor] = new ExecutorLocalMcp(ctx).listTools();

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
    const ctx = makeContext({
      modelsRegistry: {
        getValidMcpServersForRole: () => [],
      } as unknown as ModelRegistry,
    });

    const [descriptor] = new ExecutorLocalMcp(ctx).listTools();

    const toolProperty = (descriptor.inputSchema as { properties: { tool: { enum?: string[] } } })
      .properties.tool;
    expect(toolProperty.enum).toBeUndefined();
    expect(descriptor.description).toContain("No executor-side tools are currently mounted");
  });

  test("advertises executor__list_tools alongside dispatch", () => {
    const { modelsRegistry, mcpRegistry } = makeRegistries();
    const ctx = makeContext({ modelsRegistry, mcpRegistry });

    const tools = new ExecutorLocalMcp(ctx).listTools();

    expect(tools.map((tool) => tool.name)).toEqual(["executor__dispatch", "executor__list_tools"]);
  });
});

describe("ExecutorLocalMcp.callTool list_tools", () => {
  test("returns the executor's tool descriptors as JSON without dispatching", async () => {
    const modelsRegistry = {
      getValidMcpServersForRole: (role: string) => (role === "executor" ? ["fsmcp"] : []),
    } as unknown as ModelRegistry;
    const mcpRegistry = {
      getClient: () => ({
        listTools: () => [{ name: "fsmcp__write_file", description: "write", inputSchema: {} }],
      }),
    } as unknown as McpClientRegistry;
    const ctx = makeContext({ modelsRegistry, mcpRegistry });

    const result = await new ExecutorLocalMcp(ctx).callTool("list_tools", {});

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content) as { name: string }[];
    expect(parsed.map((tool) => tool.name)).toEqual(["fsmcp__write_file"]);
  });
});
