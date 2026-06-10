import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getContextSnapshot } from "../../src/agent/context-loader.js";
import type { McpToolClient } from "../../src/agent/mcp-client.js";
import type { ModelRegistry } from "../../src/agent/model-registry.js";
import type { ToolDescriptor } from "../../src/agent/providers/provider.js";
import { ContextMiddleware } from "../../src/agent/runtime/middleware/context.js";
import { createSession } from "../../src/agent/session.js";
import { SessionStore } from "../../src/agent/session-store.js";
import type { Workspace } from "../../src/agent/workspace-registry.js";
import { makeContext } from "./context.js";

/**
 * ContextMiddleware business logic: snapshot the non-conversation context the
 * orchestrator will send (system prompt + project direction + tool block),
 * store it content-addressed, and stamp the hash onto the session — including
 * the includeSubSessions toggle the sub-runtime relies on to reduce its tools.
 */

const READ_TOOL: ToolDescriptor = {
  name: "read_file",
  description: "read a file",
  inputSchema: { type: "object" },
};

/**
 * registry whose orchestrator provider reports the given model + tool mode.
 * `whitelist` mimics ModelRegistry.filterMcpToolsForRole: a missing entry for a
 * role means "unrestricted", otherwise only tools from whitelisted MCP servers survive.
 */
function fakeRegistry(
  modelId: string,
  nativeTools: boolean,
  whitelist?: Partial<Record<string, string[]>>
): ModelRegistry {
  return {
    getProviderForRole: () => ({ modelId, supportsNativeTools: nativeTools }),
    filterMcpToolsForRole: (role: string, tools: ToolDescriptor[]) => {
      const list = whitelist?.[role];
      if (!list) return tools;
      const allow = new Set(list);
      return tools.filter((tool) => {
        const serverName = tool.name.split("__")[0];
        return allow.has(serverName);
      });
    },
  } as unknown as ModelRegistry;
}

/** tools client exposing the two tool lists the middleware reads. */
function fakeTools(): McpToolClient {
  return {
    listToolsForOrchestrator: () => [READ_TOOL],
    listToolsForExecutor: () => [],
  } as unknown as McpToolClient;
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

  function ctxWith(nativeTools = true, whitelist?: Partial<Record<string, string[]>>) {
    const session = createSession({ sessionId: "s1", workspaceId: "ws-1" });
    return makeContext({
      registry: fakeRegistry("gemini-x", nativeTools, whitelist),
      tools: fakeTools(),
      store,
      session,
      workspace: fakeWorkspace(),
    });
  }

  test("stamps session.contextHash and persists the session with it", async () => {
    const ctx = ctxWith();
    const next = jest.fn(async () => {});

    await new ContextMiddleware({ contextsDir }).initialize(ctx, next);

    expect(ctx.session!.contextHash).toMatch(/^[0-9a-f]{16}$/);
    const persisted = await store.load("s1");
    expect(persisted?.contextHash).toBe(ctx.session!.contextHash);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test("writes a content-addressed snapshot reflecting the orchestrator provider", async () => {
    const ctx = ctxWith(true);

    await new ContextMiddleware({ contextsDir }).initialize(ctx, async () => {});

    const snapshot = await getContextSnapshot(contextsDir, ctx.session!.contextHash!);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.model).toBe("gemini-x");
    expect(snapshot!.nativeTools).toBe(true);
    expect(snapshot!.tools.some((t) => t.name === "read_file")).toBe(true);
  });

  test("includeSubSessions:true records the sub-session tools (default)", async () => {
    const ctx = ctxWith();

    await new ContextMiddleware({ contextsDir }).initialize(ctx, async () => {});

    const snapshot = await getContextSnapshot(contextsDir, ctx.session!.contextHash!);
    expect(snapshot!.tools.some((t) => t.name === "create_subsession")).toBe(true);
  });

  test("includeSubSessions:false drops the sub-session tools, yielding a different hash", async () => {
    const withSub = ctxWith();
    await new ContextMiddleware({ contextsDir }).initialize(withSub, async () => {});

    const withoutSub = ctxWith();
    await new ContextMiddleware({ contextsDir, includeSubSessions: false }).initialize(
      withoutSub,
      async () => {}
    );

    const reduced = await getContextSnapshot(contextsDir, withoutSub.session!.contextHash!);
    expect(reduced!.tools.some((t) => t.name === "create_subsession")).toBe(false);
    // The tool block differs, so the fingerprint must differ too.
    expect(withoutSub.session!.contextHash).not.toBe(withSub.session!.contextHash);
  });

  test("a per-model whitelist drops non-listed tools from the snapshot", async () => {
    // Orchestrator whitelist that does NOT include read_file → it must be gone,
    // while synthetic control tools (added after filtering) remain.
    const ctx = ctxWith(true, { orchestrator: ["codemcp__search_code"] });

    await new ContextMiddleware({ contextsDir }).initialize(ctx, async () => {});

    const snapshot = await getContextSnapshot(contextsDir, ctx.session!.contextHash!);
    expect(snapshot!.tools.some((t) => t.name === "read_file")).toBe(false);
    expect(snapshot!.tools.some((t) => t.name === "create_subsession")).toBe(true);
  });

  test("an empty whitelist removes every model tool but keeps synthetic tools", async () => {
    const ctx = ctxWith(true, { orchestrator: [] });

    await new ContextMiddleware({ contextsDir }).initialize(ctx, async () => {});

    const snapshot = await getContextSnapshot(contextsDir, ctx.session!.contextHash!);
    expect(snapshot!.tools.some((t) => t.name === "read_file")).toBe(false);
    expect(snapshot!.tools.some((t) => t.name === "create_subsession")).toBe(true);
  });

  test("throws when session/workspace/store have not been set", async () => {
    const ctx = makeContext({ registry: fakeRegistry("m", true), tools: fakeTools() });
    const next = jest.fn(async () => {});

    await expect(new ContextMiddleware({ contextsDir }).initialize(ctx, next)).rejects.toThrow(
      /requires ctx\.session, ctx\.workspace and ctx\.store/
    );
    expect(next).not.toHaveBeenCalled();
  });
});
