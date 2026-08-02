import { describe, expect, jest, test } from "@jest/globals";

import { McpRegistryMiddleware } from "../../src/agent/runtime/middleware/mcp-registry.js";
import { McpRegistryToken } from "../../src/agent/runtime/tokens.js";
import { ScopedToolClient } from "../../src/agent/scoped-tool-client.js";
import type { Workspace } from "../../src/agent/registries/workspace-registry.js";
import type { ModelRegistry } from "../../src/agent/registries/model-registry.js";
import type { ConfigurationRegistry } from "../../src/agent/registries/configuration-registry.js";
import { makeContext } from "./context.js";
import { createSession } from "../../src/agent/session/session.js";

// Stub the lookups the middleware reads to mount the role's servers and wire
// each server's injected tool timeout.
const stubModelsRegistry = {
  getValidModelForRole: (role: string) => (role === "executor" ? "m-exec" : "m-orch"),
  getValidMcpServersForRole: () => ["fsmcp", "excel"],
  getTimeoutForRole: () => 60000,
  getRoleDefinition: (role: string) => ({ dispatchable: role === "executor" }),
  // no evaluator role → the evaluator seam is skipped, keeping these tests focused on the mount split
  getRoles: () => [],
  // no `agents` grant: these tests cover the server/executor mount split, not the role-agent one
  getAgentsForRole: () => [],
} as unknown as ModelRegistry;

// the middleware reads only the external mcp.json defs off config; no test mounts stdio servers, so empty is fine
const stubConfigurationRegistry = {
  getMcpServerDefs: () => ({}),
} as unknown as ConfigurationRegistry;


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
      configurationRegistry: stubConfigurationRegistry,
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
      // the orchestrator whitelists "executor" — the tool grant that mounts the dispatch seam
      getValidMcpServersForRole: (role: string) =>
        role === "executor" ? ["fsmcp"] : ["fsreadonly", "executor"],
      getTimeoutForRole: () => 60000,
      getRoleDefinition: (role: string) => ({ dispatchable: role === "executor" }),
      getRoles: () => [],
      // no `agents` grant: these tests cover the server/executor mount split, not the role-agent one
      getAgentsForRole: () => [],
    } as unknown as ModelRegistry;

    const session = createSession({ sessionId: "s1", workspaceId: "ws-1", conversationId: "c1" });
    const workspace: Workspace = { workspaceId: "ws-1", root: "/tmp/workspace", projectContext: null };
    const ctx = makeContext({
      session,
      workspace,
      sandboxRoot: "/tmp/sandbox",
      mcpRegistry: undefined,
      modelsRegistry: splitModelsRegistry,
      configurationRegistry: stubConfigurationRegistry,
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
      getTimeoutForRole: () => 60000,
      getRoleDefinition: () => ({ dispatchable: true }),
      getRoles: () => [],
      // no `agents` grant: these tests cover the server/executor mount split, not the role-agent one
      getAgentsForRole: () => [],
    } as unknown as ModelRegistry;

    const session = createSession({ sessionId: "s1", workspaceId: "ws-1", conversationId: "c1" });
    const workspace: Workspace = { workspaceId: "ws-1", root: "/tmp/workspace", projectContext: null };
    const ctx = makeContext({
      session,
      workspace,
      sandboxRoot: "/tmp/sandbox",
      mcpRegistry: undefined,
      modelsRegistry: executorModelsRegistry,
      configurationRegistry: stubConfigurationRegistry,
    });

    await new McpRegistryMiddleware({ role: "executor" }).initialize(ctx, jest.fn(async () => {}));

    const mcpRegistry = ctx.registry.get(McpRegistryToken);
    expect(mcpRegistry.getClient("fsmcp")).toBeDefined();
    expect(mcpRegistry.getClient("executor")).toBeUndefined();
  });

  test("a coordinator role mounts the evaluator dispatch client; a leaf role does not", async () => {
    // the evaluator seam is a dispatch tool the loop's epilogue calls — mounted for non-dispatchable roles only
    const evaluatorAwareRegistry = {
      getValidModelForRole: () => "m-eval",
      getValidMcpServersForRole: () => ["fsreadonly"],
      getTimeoutForRole: () => 60000,
      getRoles: () => ["orchestrator", "evaluator"],
      // the evaluator seam is NOT an `agents` grant — the epilogue reaches it directly, so no role lists it
      getAgentsForRole: () => [],
      getRoleDefinition: (role: string) =>
        role === "evaluator"
          ? { dispatchable: true, dispatch: { description: "verify", returns: { required: ["status"] } } }
          : { dispatchable: false },
    } as unknown as ModelRegistry;

    const session = createSession({ sessionId: "s1", workspaceId: "ws-1", conversationId: "c1" });
    const workspace: Workspace = { workspaceId: "ws-1", root: "/tmp/workspace", projectContext: null };
    const mount = (role: string) =>
      makeContext({
        session,
        workspace,
        sandboxRoot: "/tmp/sandbox",
        mcpRegistry: undefined,
        modelsRegistry: evaluatorAwareRegistry,
        configurationRegistry: stubConfigurationRegistry,
      });

    const coordinatorCtx = mount("orchestrator");
    await new McpRegistryMiddleware({ role: "orchestrator" }).initialize(coordinatorCtx, jest.fn(async () => {}));
    expect(coordinatorCtx.registry.get(McpRegistryToken).getClient("evaluator")).toBeDefined();

    const leafCtx = mount("evaluator");
    await new McpRegistryMiddleware({ role: "evaluator" }).initialize(leafCtx, jest.fn(async () => {}));
    // the evaluator's own child run is a leaf — no evaluator seam, so it can't recursively self-judge
    expect(leafCtx.registry.get(McpRegistryToken).getClient("evaluator")).toBeUndefined();
  });

  test("a role's `agents` list mounts each granted role as <role>__ask; an empty list is a leaf", async () => {
    // `agents` is the grant, separate from `tools`: depth is bounded by config, so a role granting none is a leaf
    const agentAwareRegistry = {
      getValidModelForRole: () => "m-orch",
      getValidMcpServersForRole: () => ["fsreadonly"],
      getTimeoutForRole: () => 60000,
      getRoles: () => ["orchestrator", "filesagent", "notdispatchable"],
      getAgentsForRole: (role: string) =>
        role === "orchestrator" ? ["filesagent", "notdispatchable", "missingrole"] : [],
      getRoleDefinition: (role: string) =>
        role === "filesagent"
          ? { dispatchable: true, dispatch: { description: "ask files", returns: { required: ["found"] } } }
          : { dispatchable: false },
    } as unknown as ModelRegistry;

    const session = createSession({ sessionId: "s1", workspaceId: "ws-1", conversationId: "c1" });
    const workspace: Workspace = { workspaceId: "ws-1", root: "/tmp/workspace", projectContext: null };
    const mount = () =>
      makeContext({
        session,
        workspace,
        sandboxRoot: "/tmp/sandbox",
        mcpRegistry: undefined,
        modelsRegistry: agentAwareRegistry,
        configurationRegistry: stubConfigurationRegistry,
      });

    const granterCtx = mount();
    await new McpRegistryMiddleware({ role: "orchestrator" }).initialize(granterCtx, jest.fn(async () => {}));
    const granted = granterCtx.registry.get(McpRegistryToken);
    expect(granted.getClient("filesagent")).toBeDefined();
    expect(granted.listTools().map((t) => t.name)).toContain("filesagent__ask");
    // mounted is not the same as VISIBLE: the grant must also reach the model's scoped surface,
    // which composes from the server whitelist — where a role-agent deliberately does not appear
    const surface = ScopedToolClient.forRole(granted, agentAwareRegistry, "orchestrator")
      .listTools()
      .map((t) => t.name);
    expect(surface).toContain("filesagent__ask");
    // granted-but-ungrantable names drop out rather than throwing: not dispatchable, and not a role at all
    expect(granted.getClient("notdispatchable")).toBeUndefined();
    expect(granted.getClient("missingrole")).toBeUndefined();

    const leafCtx = mount();
    await new McpRegistryMiddleware({ role: "filesagent" }).initialize(leafCtx, jest.fn(async () => {}));
    expect(leafCtx.registry.get(McpRegistryToken).getClient("filesagent")).toBeUndefined();
  });
});
