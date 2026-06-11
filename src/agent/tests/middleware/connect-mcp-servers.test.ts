import { describe, expect, jest, test } from "@jest/globals";

import { ConnectMcpServersMiddleware } from "../../src/agent/runtime/middleware/connect-mcp-servers.js";
import type { McpClientRegistry } from "../../src/agent/registries/mcp-registry.js";
import { makeContext } from "./context.js";

/**
 * ConnectMcpServersMiddleware business logic.
 *
 * This middleware connects all registered MCP servers (both in-process and stdio
 * from mcp.json). Once connected, all tools become available to the orchestrator.
 */
describe("ConnectMcpServersMiddleware", () => {
  test("connects all registered MCP servers and continues", async () => {
    const mockMcpRegistry = {
      connectAll: jest.fn(async () => {}),
    } as unknown as McpClientRegistry;

    const ctx = makeContext({
      mcpRegistry: mockMcpRegistry,
    });
    const next = jest.fn(async () => {});

    await new ConnectMcpServersMiddleware().initialize(ctx, next);

    expect(mockMcpRegistry.connectAll).toHaveBeenCalledWith(ctx.mcpConfigPath);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test("passes mcpConfigPath to connectAll", async () => {
    const customPath = "/custom/path/mcp.json";
    const mockMcpRegistry = {
      connectAll: jest.fn(async () => {}),
    } as unknown as McpClientRegistry;

    const ctx = makeContext({
      mcpRegistry: mockMcpRegistry,
      mcpConfigPath: customPath,
    });
    const next = jest.fn(async () => {});

    await new ConnectMcpServersMiddleware().initialize(ctx, next);

    expect(mockMcpRegistry.connectAll).toHaveBeenCalledWith(customPath);
  });
});
