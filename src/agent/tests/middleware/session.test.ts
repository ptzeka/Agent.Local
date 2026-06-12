import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ANONYMOUS_PRINCIPAL } from "../../src/agent/identity/types.js";
import type { McpClient } from "../../src/agent/mcp-client.js";
import { SessionMiddleware } from "../../src/agent/runtime/middleware/session.js";
import { createSession } from "../../src/agent/session/session.js";
import { SessionStore } from "../../src/agent/session/session-store.js";
import { WorkspaceRegistry } from "../../src/agent/registries/workspace-registry.js";
import { makeContext } from "./context.js";

/**
 * Minimal tools stub carrying just the `sandboxRoot` SessionMiddleware reads to
 * create the session's workspace segment dir. Rooted in the test's temp dir so
 * the created segment is cleaned up with everything else in afterEach.
 */
function fakeTools(root: string): McpClient {
  return { sandboxRoot: path.join(root, "sandbox") } as unknown as McpClient;
}

/**
 * SessionMiddleware business logic: open a fresh session or resume a persisted
 * one, register its workspace, stamp the resolved identity, and heal a
 * crash-interrupted transcript on resume.
 */
describe("SessionMiddleware", () => {
  let root: string;
  let store: SessionStore;
  let workspaces: WorkspaceRegistry;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "session-mw-"));
    store = SessionStore.create(path.join(root, "sessions"));
    workspaces = new WorkspaceRegistry();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  test("opens a fresh session, resolves its workspace, stamps the user, and persists it", async () => {
    const ctx = makeContext({
      workspaceRoot: root,
      store,
      workspaces,
      user: ANONYMOUS_PRINCIPAL,
      tools: fakeTools(root),
    });
    const next = jest.fn(async () => {});

    await new SessionMiddleware().initialize(ctx, next);

    expect(ctx.session).toBeDefined();
    expect(ctx.workspace?.workspaceId).toBe(ctx.session!.workspaceId);
    expect(ctx.session!.user).toBe(ANONYMOUS_PRINCIPAL);
    expect((await store.load(ctx.session!.sessionId))?.sessionId).toBe(ctx.session!.sessionId);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test("resuming heals a crash-interrupted session: normalizes the leftover running status", async () => {
    const crashed = createSession({ sessionId: "crashed", workspaceId: "ws-1", conversationId: "c-1" });
    crashed.status = "running"; // left over from a process that died mid-turn
    await store.save(crashed);

    const ctx = makeContext({ workspaceRoot: root, store, workspaces, tools: fakeTools(root) });
    await new SessionMiddleware({ sessionId: "crashed" }).initialize(ctx, jest.fn(async () => {}));

    expect(ctx.session!.status).toBe("awaiting-input");
    // Transcript healing (dangling tool_use trim) is ConversationMiddleware's
    // job now — covered in conversation.test.ts.
  });

  test("throws when the store/workspaces steps have not run", async () => {
    const ctx = makeContext({ workspaceRoot: root }); // store + workspaces undefined
    const next = jest.fn(async () => {});

    await expect(new SessionMiddleware().initialize(ctx, next)).rejects.toThrow(
      /requires ctx\.store and ctx\.workspaces/
    );
    expect(next).not.toHaveBeenCalled();
  });
});
