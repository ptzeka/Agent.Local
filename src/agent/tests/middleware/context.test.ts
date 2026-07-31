import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";

import { ContextLoader } from "../../src/agent/context/context-loader.js";
import type { ModelRegistry } from "../../src/agent/registries/model-registry.js";
import type { ProvidersRegistry } from "../../src/agent/registries/providers-registry.js";
import type { McpClientRegistry } from "../../src/agent/registries/mcp-registry.js";
import type { ToolDescriptor } from "@agent-local/mcp/tooldescriptor";
import { ContextMiddleware } from "../../src/agent/runtime/middleware/context.js";
import { SessionToken } from "../../src/agent/runtime/tokens.js";
import { createSession } from "../../src/agent/session/session.js";
import { SessionStore } from "../../src/agent/session/session-store.js";
import type { Workspace } from "../../src/agent/registries/workspace-registry.js";
import type { DatabaseHandle } from "@agent-local/common/db";
import { makeContext, makeTestDb } from "./context.js";

// snapshots the non-conversation context a role sends (system prompt + project direction + tool block),
// stores it content-addressed, and stamps the hash onto the session under that role. The middleware reads
// the role's provider/template from providerRegistry/modelsRegistry and its tools from mcpRegistry.getClient.

const READ_TOOL: ToolDescriptor = {
  name: "read_file",
  description: "read a file",
  inputSchema: { type: "object" },
};

// modelsRegistry stub: resolves every role to one model key and serves a per-role template
function fakeModelsRegistry(): ModelRegistry {
  return {
    getProviderForRole: (_role: string) => "the-model",
    getPromptTemplate: (role: string) =>
      role === "executor" ? "# Executor Prompt\nExecute the task." : "# System Prompt\nYou are a helpful assistant.",
    // the role's model is allowed one server; the fake mcpRegistry serves it regardless of name
    getValidMcpServersForRole: (_role: string) => ["fsmcp"],
    getAgentsForRole: () => [],
  } as unknown as ModelRegistry;
}

// providersRegistry stub: resolves the model key to a provider reporting the given model + tool mode
function fakeProvidersRegistry(modelId: string, nativeTools: boolean): ProvidersRegistry {
  return {
    getProvider: (_name: string) => ({ modelId, supportsNativeTools: nativeTools }),
  } as unknown as ProvidersRegistry;
}

// mcpRegistry stub: every role's client advertises the given tool list
function fakeMcpRegistry(tools: ToolDescriptor[]): McpClientRegistry {
  return {
    sandboxRoot: "/tmp/sandbox",
    getClient: (_role: string) => ({
      name: "fsmcp",
      listTools: () => tools,
      callTool: jest.fn(),
      shutdown: jest.fn(),
    }),
  } as unknown as McpClientRegistry;
}

function fakeWorkspace(): Workspace {
  return { workspaceId: "ws-1", root: "/tmp/ws", projectContext: null } as Workspace;
}

describe("ContextMiddleware", () => {
  let db: DatabaseHandle;
  let store: SessionStore;

  beforeEach(() => {
    db = makeTestDb();
    store = SessionStore.create(db);
  });

  afterEach(() => {
    db.close();
  });

  function ctxWith(nativeTools = true, tools: ToolDescriptor[] = [READ_TOOL]) {
    const session = createSession({ sessionId: "s1", workspaceId: "ws-1", conversationId: "c1" });
    return makeContext({
      db,
      modelsRegistry: fakeModelsRegistry(),
      providerRegistry: fakeProvidersRegistry("gemini-x", nativeTools),
      mcpRegistry: fakeMcpRegistry(tools),
      store,
      session,
      workspace: fakeWorkspace(),
    });
  }

  test("stamps session.contextHash and persists the session with it", async () => {
    const ctx = ctxWith();
    const next = jest.fn(async () => {});

    await new ContextMiddleware({ roleName: "orchestrator" }).initialize(ctx, next);

    const session = ctx.registry.get(SessionToken);
    expect(session.contextHashes?.["orchestrator"]).toMatch(/^[0-9a-f]{16}$/);
    const persisted = await store.getSessionById("s1");
    expect(persisted?.contextHashes?.["orchestrator"]).toBe(session.contextHashes?.["orchestrator"]);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test("writes a content-addressed snapshot reflecting the role's prompt and tools", async () => {
    const ctx = ctxWith(true);

    await new ContextMiddleware({ roleName: "orchestrator" }).initialize(ctx, async () => {});

    const loader = ContextLoader.create(db);
    const snapshot = await loader.getContextSnapshot(ctx.registry.get(SessionToken).contextHashes?.["orchestrator"]!);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.role).toBe("orchestrator");
    expect(snapshot!.systemPrompt).toContain("You are a helpful assistant.");
    expect(snapshot!.tools.some((t) => t.name === "read_file")).toBe(true);
  });

  test("different roles yield different context hashes (distinct prompt templates)", async () => {
    const orch = ctxWith();
    await new ContextMiddleware({ roleName: "orchestrator" }).initialize(orch, async () => {});

    const exec = ctxWith();
    await new ContextMiddleware({ roleName: "executor" }).initialize(exec, async () => {});

    const orchHash = orch.registry.get(SessionToken).contextHashes?.["orchestrator"];
    const execHash = exec.registry.get(SessionToken).contextHashes?.["executor"];
    expect(orchHash).toBeDefined();
    expect(execHash).toBeDefined();
    expect(execHash).not.toBe(orchHash);
  });

  test("throws when session/workspace/store have not been set", async () => {
    const ctx = makeContext();
    const next = jest.fn(async () => {});

    await expect(
      new ContextMiddleware({ roleName: "orchestrator" }).initialize(ctx, next)
    ).rejects.toThrow(/no instance registered for "session"/);
    expect(next).not.toHaveBeenCalled();
  });
});
