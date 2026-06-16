import { describe, expect, jest, test } from "@jest/globals";

import { McpRegistryMiddleware } from "../../src/agent/runtime/middleware/mcp-registry.js";
import { McpRegistryToken } from "../../src/agent/runtime/tokens.js";
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

// constructs the MCP client registry (bound to the sandbox root), registers the in-process servers
// (filesystem and Excel) as LocalMcp instances on it, then continues the chain
describe("McpRegistryMiddleware", () => {
  test("throws without workspace and session", async () => {
    const ctx = makeContext({ session: undefined, workspace: undefined });
    const next = jest.fn(async () => {});

    await expect(
      new McpRegistryMiddleware({ role: "orchestrator" }).initialize(ctx, next)
    ).rejects.toThrow(/no instance registered for "workspace"/);
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

    const mcpRegistry = ctx.registry.tryGet(McpRegistryToken);
    expect(mcpRegistry).toBeDefined();
    expect(mcpRegistry!.sandboxRoot).toBe("/tmp/sandbox");
    expect(mcpRegistry!.getClient("fsmcp")).toBeDefined();
    expect(mcpRegistry!.getClient("excel")).toBeDefined();
    expect(next).toHaveBeenCalledTimes(1);
  });

  test("executor dispatch advertises the executor's write tools without leaking them to the orchestrator", async () => {
    // Orchestrator mounts read-only fs; executor mounts writable fs. The
    // executor's tools must surface in the dispatch enum but NEVER in the
    // orchestrator's own registry.
    const splitModelsRegistry = {
      getValidModelForRole: (role: string) => (role === "executor" ? "m-exec" : "m-orch"),
      getValidMcpServersForRole: (role: string) =>
        role === "executor" ? ["fsmcp"] : ["fsreadonly"],
      getTimeoutForModel: () => 60000,
    } as unknown as ModelRegistry;

    const session = createSession({ sessionId: "s1", workspaceId: "ws-1", conversationId: "c1" });
    const workspace: Workspace = { workspaceId: "ws-1", root: "/tmp/workspace", projectContext: null };
    const ctx = makeContext({
      session,
      workspace,
      sandboxRoot: "/tmp/sandbox",
      mcpRegistry: undefined,
      modelsRegistry: splitModelsRegistry,
    });

    await new McpRegistryMiddleware({ role: "orchestrator" }).initialize(ctx, jest.fn(async () => {}));

    // A fsreadonly-only role actually gets its read server (regression: the
    // switch previously had no case for it, so the orchestrator got no fs).
    const mcpRegistry = ctx.registry.get(McpRegistryToken);
    expect(mcpRegistry.getClient("fsreadonly")).toBeDefined();

    // The write server never lands in the orchestrator's registry — it lives only in the executor's.
    expect(mcpRegistry.getClient("fsmcp")).toBeUndefined();

    // The executor dispatch enum DOES expose the executor's write tools.
    const [dispatch] = mcpRegistry.getClient("executor")!.listTools();
    const enumNames = (dispatch.inputSchema as { properties: { tool: { enum?: string[] } } })
      .properties.tool.enum;
    expect(enumNames).toContain("fsmcp__write_file");
  });

  test("an executor child gets its own write servers but NO dispatch seam (no grandchildren)", async () => {
    // role "executor" mounts its writable fs directly; it must never receive an executor seam,
    // or a dispatch could spawn a grandchild — the one-level-deep invariant.
    const executorModelsRegistry = {
      getValidModelForRole: () => "m-exec",
      getValidMcpServersForRole: () => ["fsmcp"],
      getTimeoutForModel: () => 60000,
    } as unknown as ModelRegistry;

    const session = createSession({ sessionId: "s1", workspaceId: "ws-1", conversationId: "c1" });
    const workspace: Workspace = { workspaceId: "ws-1", root: "/tmp/workspace", projectContext: null };
    const ctx = makeContext({
      session,
      workspace,
      sandboxRoot: "/tmp/sandbox",
      mcpRegistry: undefined,
      modelsRegistry: executorModelsRegistry,
    });

    await new McpRegistryMiddleware({ role: "executor" }).initialize(ctx, jest.fn(async () => {}));

    const mcpRegistry = ctx.registry.get(McpRegistryToken);
    expect(mcpRegistry.getClient("fsmcp")).toBeDefined();
    expect(mcpRegistry.getClient("executor")).toBeUndefined();
  });
});
