import { describe, expect, jest, test } from "@jest/globals";

import { AddMcpServersMiddleware } from "../../src/agent/runtime/middleware/add-mcp-servers.js";
import type { McpClientRegistry } from "../../src/agent/registries/mcp-registry.js";
import type { Workspace } from "../../src/agent/registries/workspace-registry.js";
import { makeContext } from "./context.js";
import { createSession } from "../../src/agent/session/session.js";

/**
 * AddMcpServersMiddleware business logic.
 *
 * This middleware registers in-process MCP servers (filesystem and Excel) with
 * the MCP registry. They are registered but not yet connected — that happens in
 * ConnectMcpServersMiddleware.
 */
describe("AddMcpServersMiddleware", () => {
  test("throws without workspace and session", async () => {
    const ctx = makeContext();
    const next = jest.fn(async () => {});

    await expect(
      new AddMcpServersMiddleware().initialize(ctx, next)
    ).rejects.toThrow("workspace and session must be available");
  });

  test("registers filesystem and Excel servers with the registry", async () => {
    const session = createSession({ sessionId: "s1", workspaceId: "ws-1" });
    const workspace: Workspace = {
      workspaceId: "ws-1",
      root: "/tmp/workspace",
      projectContext: null,
    };

    const mockMcpRegistry = {
      registerInProcessServer: jest.fn(),
      sandboxRoot: "/tmp/sandbox",
      listToolsForOrchestrator: () => [],
      listToolsForExecutor: () => [],
    } as unknown as McpClientRegistry;

    const ctx = makeContext({
      session,
      workspace,
      mcpRegistry: mockMcpRegistry,
    });
    const next = jest.fn(async () => {});

    await new AddMcpServersMiddleware().initialize(ctx, next);

    expect(mockMcpRegistry.registerInProcessServer).toHaveBeenCalledTimes(2);
    const calls = (mockMcpRegistry.registerInProcessServer as jest.Mock).mock.calls;
    expect(calls[0][0]).toBe("fsmcp");
    expect(calls[1][0]).toBe("excel");
    expect(next).toHaveBeenCalledTimes(1);
  });
});
