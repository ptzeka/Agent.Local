import { describe, expect, jest, test } from "@jest/globals";

import { McpRegistryMiddleware } from "../../src/agent/runtime/middleware/mcp-registry.js";
import type { Workspace } from "../../src/agent/registries/workspace-registry.js";
import type { ModelRegistry } from "../../src/agent/registries/model-registry.js";
import { makeContext } from "./context.js";
import { createSession } from "../../src/agent/session/session.js";

// Stub the lookups the middleware reads to mount the role's servers and wire
// each server's injected tool timeout.
const stubModelsRegistry = {
  getValidModelForRole: (role: string) => (role === "executor" ? "m-exec" : "m-orch"),
  getValidMcpServersForRole: () => ["fsmcp", "excel"],
  getTimeoutForModel: () => 60000,
} as unknown as ModelRegistry;

/**
 * McpRegistryMiddleware business logic.
 *
 * This middleware constructs the MCP client registry (bound to the sandbox
 * root) and registers the in-process MCP servers (filesystem and Excel) as
 * `LocalMcp` instances on it, then continues the chain.
 */
describe("McpRegistryMiddleware", () => {
  test("throws without workspace and session", async () => {
    const ctx = makeContext({ session: undefined, workspace: undefined });
    const next = jest.fn(async () => {});

    await expect(
      new McpRegistryMiddleware({ role: "orchestrator" }).initialize(ctx, next)
    ).rejects.toThrow("workspace and session must be available");
  });

  test("creates the registry and registers filesystem and Excel servers", async () => {
    const session = createSession({ sessionId: "s1", workspaceId: "ws-1", conversationId: "c1" });
    const workspace: Workspace = {
      workspaceId: "ws-1",
      root: "/tmp/workspace",
      projectContext: null,
    };

    const ctx = makeContext({
      session,
      workspace,
      sandboxRoot: "/tmp/sandbox",
      mcpRegistry: undefined,
      modelsRegistry: stubModelsRegistry,
    });
    const next = jest.fn(async () => {});

    await new McpRegistryMiddleware({ role: "orchestrator" }).initialize(ctx, next);

    expect(ctx.mcpRegistry).toBeDefined();
    expect(ctx.mcpRegistry!.sandboxRoot).toBe("/tmp/sandbox");
    expect(ctx.mcpRegistry!.getClient("fsmcp")).toBeDefined();
    expect(ctx.mcpRegistry!.getClient("excel")).toBeDefined();
    // The role scope is wired through: the factory fronts the whitelisted mounts.
    expect(ctx.mcpRegistry!.createScopedClient().listTools().length).toBeGreaterThan(0);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
