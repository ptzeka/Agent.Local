import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ANONYMOUS_PRINCIPAL } from "../../src/agent/identity/types.js";
import type { McpClient } from "../../src/agent/mcp-client.js";
import { SessionMiddleware } from "../../src/agent/runtime/middleware/session.js";
import { SessionToken, WorkspaceToken } from "../../src/agent/runtime/tokens.js";
import { createSession } from "../../src/agent/session/session.js";
import { SessionStore } from "../../src/agent/session/session-store.js";
import { WorkspaceRegistry } from "../../src/agent/registries/workspace-registry.js";
import type { DatabaseHandle } from "@agent-local/common/db";
import { makeContext, makeTestDb } from "./context.js";

// minimal tools stub carrying just the sandboxRoot SessionMiddleware reads to create the session's
// workspace segment dir; rooted in the test's temp dir so the segment is cleaned up in afterEach
function fakeTools(root: string): McpClient {
  return { sandboxRoot: path.join(root, "sandbox") } as unknown as McpClient;
}

// opens a fresh session or resumes a persisted one, registers its workspace, stamps the resolved identity,
// and heals a crash-interrupted transcript on resume
describe("SessionMiddleware", () => {
  let root: string;
  let db: DatabaseHandle;
  let store: SessionStore;
  let workspaces: WorkspaceRegistry;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "session-mw-"));
    db = makeTestDb();
    store = SessionStore.create(db);
    workspaces = new WorkspaceRegistry();
  });

  afterEach(async () => {
    db.close();
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

    const session = ctx.registry.tryGet(SessionToken);
    expect(session).toBeDefined();
    expect(ctx.registry.tryGet(WorkspaceToken)?.workspaceId).toBe(session!.workspaceId);
    expect(session!.user).toBe(ANONYMOUS_PRINCIPAL);
    expect((await store.getSessionById(session!.sessionId))?.sessionId).toBe(session!.sessionId);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test("resuming heals a crash-interrupted session: normalizes the leftover running status", async () => {
    const crashed = createSession({ sessionId: "crashed", workspaceId: "ws-1", conversationId: "c-1" });
    crashed.status = "running"; // left over from a process that died mid-turn
    await store.save(crashed);

    const ctx = makeContext({ workspaceRoot: root, store, workspaces, tools: fakeTools(root) });
    await new SessionMiddleware({ sessionId: "crashed" }).initialize(ctx, jest.fn(async () => {}));

    expect(ctx.registry.get(SessionToken).status).toBe("awaiting-input");
    // Transcript healing (dangling tool_use trim) is ConversationMiddleware's
    // job now — covered in conversation.test.ts.
  });

  test("resume refuses a session owned by a different authenticated user", async () => {
    const owned = createSession({ sessionId: "owned", workspaceId: "ws-1", conversationId: "c-1" });
    owned.user = { sub: "alice", isAuthenticated: true, claims: { sub: "alice" }, scopes: [] };
    await store.save(owned);

    const asBob = makeContext({
      workspaceRoot: root,
      store,
      workspaces,
      user: { sub: "bob", isAuthenticated: true, claims: { sub: "bob" }, scopes: [] },
      tools: fakeTools(root),
    });
    await expect(
      new SessionMiddleware({ sessionId: "owned" }).initialize(asBob, jest.fn(async () => {}))
    ).rejects.toThrow(/belongs to another user/);

    // anonymous is refused the same way — otherwise it would strip the owner on re-save
    const asAnon = makeContext({
      workspaceRoot: root,
      store,
      workspaces,
      user: ANONYMOUS_PRINCIPAL,
      tools: fakeTools(root),
    });
    await expect(
      new SessionMiddleware({ sessionId: "owned" }).initialize(asAnon, jest.fn(async () => {}))
    ).rejects.toThrow(/belongs to another user/);
  });

  test("owner resumes their own session; a logged-in user adopts an anonymous one", async () => {
    const alice = { sub: "alice", isAuthenticated: true, claims: { sub: "alice" }, scopes: [] };
    const owned = createSession({ sessionId: "mine", workspaceId: "ws-1", conversationId: "c-1" });
    owned.user = alice;
    await store.save(owned);
    const drifter = createSession({ sessionId: "anon", workspaceId: "ws-2", conversationId: "c-2" });
    drifter.user = ANONYMOUS_PRINCIPAL;
    await store.save(drifter);

    const asOwner = makeContext({ workspaceRoot: root, store, workspaces, user: alice, tools: fakeTools(root) });
    await new SessionMiddleware({ sessionId: "mine" }).initialize(asOwner, jest.fn(async () => {}));
    expect(asOwner.registry.get(SessionToken).user?.sub).toBe("alice");

    // login-then-resume: the anonymous session is adopted by the authenticated resumer
    const adopting = makeContext({ workspaceRoot: root, store, workspaces, user: alice, tools: fakeTools(root) });
    await new SessionMiddleware({ sessionId: "anon" }).initialize(adopting, jest.fn(async () => {}));
    expect(adopting.registry.get(SessionToken).user?.sub).toBe("alice");
  });

  test("throws when the store/workspaces steps have not run", async () => {
    const ctx = makeContext({ workspaceRoot: root }); // store + workspaces undefined
    const next = jest.fn(async () => {});

    await expect(new SessionMiddleware().initialize(ctx, next)).rejects.toThrow(
      /no instance registered for "workspaces"/
    );
    expect(next).not.toHaveBeenCalled();
  });
});
