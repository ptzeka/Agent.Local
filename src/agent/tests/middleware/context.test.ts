import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ContextLoader } from "../../src/agent/context/context-loader.js";
import type { ModelRegistry } from "../../src/agent/registries/model-registry.js";
import type { ProvidersRegistry } from "../../src/agent/registries/providers-registry.js";
import type { McpClientRegistry } from "../../src/agent/registries/mcp-registry.js";
import type { ToolDescriptor } from "../../src/agent/providers/provider.js";
import { ContextMiddleware } from "../../src/agent/runtime/middleware/context.js";
import { createSession } from "../../src/agent/session/session.js";
import { SessionStore } from "../../src/agent/session/session-store.js";
import type { Workspace } from "../../src/agent/registries/workspace-registry.js";
import { makeContext } from "./context.js";

/**
 * ContextMiddleware business logic: snapshot the non-conversation context the
 * given role will send (system prompt + project direction + tool block), store
 * it content-addressed, and stamp the hash onto the session under that role.
 *
 * The middleware reads the role's provider (model id + native-tool mode) from
 * providerRegistry/modelsRegistry, the role's prompt template from
 * modelsRegistry, and the role's tools from mcpRegistry.getClient(role).
 */

const READ_TOOL: ToolDescriptor = {
  name: "read_file",
  description: "read a file",
  inputSchema: { type: "object" },
};

/** modelsRegistry stub: resolves every role to one model key and serves a per-role template. */
function fakeModelsRegistry(): ModelRegistry {
  return {
    getProviderForRole: (_role: string) => "the-model",
    getPromptTemplate: (role: string) =>
      role === "executor" ? "# Executor Prompt\nExecute the task." : "# System Prompt\nYou are a helpful assistant.",
    // The role's model is allowed one server; the fake mcpRegistry serves it regardless of name.
    getValidMcpForModel: (_role: string) => ["fsmcp"],
  } as unknown as ModelRegistry;
}

/** providersRegistry stub: resolves the model key to a provider reporting the given model + tool mode. */
function fakeProvidersRegistry(modelId: string, nativeTools: boolean): ProvidersRegistry {
  return {
    getProvider: (_name: string) => ({ modelId, supportsNativeTools: nativeTools }),
  } as unknown as ProvidersRegistry;
}

/** mcpRegistry stub: every role's client advertises the given tool list. */
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
  let root: string;
  let store: SessionStore;
  let contextsDir: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "ctx-mw-"));
    store = SessionStore.create(path.join(root, "sessions"));
    contextsDir = path.join(root, "contexts");
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  function ctxWith(nativeTools = true, tools: ToolDescriptor[] = [READ_TOOL]) {
    const session = createSession({ sessionId: "s1", workspaceId: "ws-1" });
    return makeContext({
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

    await new ContextMiddleware({ roleName: "orchestrator", contextsDir }).initialize(ctx, next);

    expect(ctx.session!.contextHashes?.["orchestrator"]).toMatch(/^[0-9a-f]{16}$/);
    const persisted = await store.load("s1");
    expect(persisted?.contextHashes?.["orchestrator"]).toBe(ctx.session!.contextHashes?.["orchestrator"]);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test("writes a content-addressed snapshot reflecting the role's prompt and tools", async () => {
    const ctx = ctxWith(true);

    await new ContextMiddleware({ roleName: "orchestrator", contextsDir }).initialize(ctx, async () => {});

    const loader = new ContextLoader(contextsDir);
    const snapshot = await loader.getContextSnapshot(ctx.session!.contextHashes?.["orchestrator"]!);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.role).toBe("orchestrator");
    expect(snapshot!.systemPrompt).toContain("You are a helpful assistant.");
    expect(snapshot!.tools.some((t) => t.name === "read_file")).toBe(true);
  });

  test("different roles yield different context hashes (distinct prompt templates)", async () => {
    const orch = ctxWith();
    await new ContextMiddleware({ roleName: "orchestrator", contextsDir }).initialize(orch, async () => {});

    const exec = ctxWith();
    await new ContextMiddleware({ roleName: "executor", contextsDir }).initialize(exec, async () => {});

    const orchHash = orch.session!.contextHashes?.["orchestrator"];
    const execHash = exec.session!.contextHashes?.["executor"];
    expect(orchHash).toBeDefined();
    expect(execHash).toBeDefined();
    expect(execHash).not.toBe(orchHash);
  });

  test("throws when session/workspace/store have not been set", async () => {
    const ctx = makeContext();
    const next = jest.fn(async () => {});

    await expect(
      new ContextMiddleware({ roleName: "orchestrator", contextsDir }).initialize(ctx, next)
    ).rejects.toThrow(/requires ctx\.session, ctx\.workspace and ctx\.store/);
    expect(next).not.toHaveBeenCalled();
  });
});
