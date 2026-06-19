import { describe, expect, jest, test } from "@jest/globals";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ChildSessionMiddleware } from "../../src/agent/runtime/middleware/child-session.js";
import { ConversationMiddleware } from "../../src/agent/runtime/middleware/conversation.js";
import { ConversationToken, SessionToken, WorkspaceToken } from "../../src/agent/runtime/tokens.js";
import type { SessionStore } from "../../src/agent/session/session-store.js";
import { SessionStore as RealSessionStore } from "../../src/agent/session/session-store.js";
import type { WorkspaceRegistry } from "../../src/agent/registries/workspace-registry.js";
import { WorkspaceRegistry as RealWorkspaceRegistry } from "../../src/agent/registries/workspace-registry.js";
import type { Principal } from "../../src/agent/identity/types.js";
import type { DatabaseHandle } from "@agent-local/common/db";
import { makeContext, makeTestDb } from "./context.js";

// a sub-session is created fresh with a pre-minted id, inherits the parent's workspace, optionally seeds
// standing context, stamps the inherited identity, and persists itself for the store/picker
describe("ChildSessionMiddleware", () => {
  let tempDir: string;
  let db: DatabaseHandle;
  let store: SessionStore;
  let workspaces: WorkspaceRegistry;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "child-session-mw-"));
    db = makeTestDb();
    store = RealSessionStore.create(db);
    workspaces = new RealWorkspaceRegistry(path.join(tempDir, "workspaces"));
  });

  afterEach(async () => {
    db.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test("throws without store and workspaces", async () => {
    const ctx = makeContext();
    const next = jest.fn(async () => {});

    await expect(
      new ChildSessionMiddleware({
        sessionId: "child-1",
        parentSessionId: "parent-1",
        workspaceId: "ws-1",
      }).initialize(ctx, next)
    ).rejects.toThrow(/no instance registered for "workspaces"/);
  });

  test("creates a child session with correct ids and persists it", async () => {
    // Register the parent's workspace first
    const workspaceRoot = path.join(tempDir, "workspace");
    await fs.mkdir(workspaceRoot, { recursive: true });
    await workspaces.register("ws-1", workspaceRoot);

    const ctx = makeContext({
      db,
      store,
      workspaces,
      workspaceRoot,
    });
    const next = jest.fn(async () => {});

    await new ChildSessionMiddleware({
      sessionId: "child-1",
      parentSessionId: "parent-1",
      workspaceId: "ws-1",
    }).initialize(ctx, next);

    const session = ctx.registry.tryGet(SessionToken);
    expect(session).toBeDefined();
    expect(session!.sessionId).toBe("child-1");
    expect(session!.parentSessionId).toBe("parent-1");
    expect(session!.workspaceId).toBe("ws-1");
    const workspace = ctx.registry.tryGet(WorkspaceToken);
    expect(workspace).toBeDefined();
    expect(workspace!.workspaceId).toBe("ws-1");
    expect(next).toHaveBeenCalledTimes(1);

    // Verify the session was persisted
    const persisted = await store.load("child-1");
    expect(persisted?.sessionId).toBe("child-1");
    expect(persisted?.parentSessionId).toBe("parent-1");
  });

  test("standing context seeds the conversation step that follows", async () => {
    const workspaceRoot = path.join(tempDir, "workspace");
    await fs.mkdir(workspaceRoot, { recursive: true });
    await workspaces.register("ws-1", workspaceRoot);

    const standingContext = "Previous work: Fixed authentication bugs";
    const ctx = makeContext({
      db,
      store,
      workspaces,
      workspaceRoot,
    });
    const next = jest.fn(async () => {});

    await new ChildSessionMiddleware({
      sessionId: "child-2",
      parentSessionId: "parent-1",
      workspaceId: "ws-1",
    }).initialize(ctx, next);
    await new ConversationMiddleware({ standingContext }).initialize(ctx, next);

    const messages = ctx.registry.get(ConversationToken).getMessages();
    expect(messages.length).toBe(1);
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain(standingContext);
  });

  test("ignores empty or whitespace-only standing context", async () => {
    const workspaceRoot = path.join(tempDir, "workspace");
    await fs.mkdir(workspaceRoot, { recursive: true });
    await workspaces.register("ws-1", workspaceRoot);

    const ctx = makeContext({
      db,
      store,
      workspaces,
      workspaceRoot,
    });
    const next = jest.fn(async () => {});

    await new ChildSessionMiddleware({
      sessionId: "child-3",
      parentSessionId: "parent-1",
      workspaceId: "ws-1",
    }).initialize(ctx, next);
    await new ConversationMiddleware({ standingContext: "   \n  \t  " }).initialize(ctx, next);

    expect(ctx.registry.get(ConversationToken).length).toBe(0);
  });

  test("stamps inherited user identity onto the session", async () => {
    const workspaceRoot = path.join(tempDir, "workspace");
    await fs.mkdir(workspaceRoot, { recursive: true });
    await workspaces.register("ws-1", workspaceRoot);

    const user: Principal = {
      id: "user-1",
      name: "Alice",
      email: "alice@example.com",
    };

    const ctx = makeContext({
      store,
      workspaces,
      workspaceRoot,
      user,
    });
    const next = jest.fn(async () => {});

    await new ChildSessionMiddleware({
      sessionId: "child-4",
      parentSessionId: "parent-1",
      workspaceId: "ws-1",
    }).initialize(ctx, next);

    expect(ctx.registry.get(SessionToken).user).toBe(user);
  });

  test("re-registers workspace when it doesn't exist yet", async () => {
    const workspaceRoot = path.join(tempDir, "workspace2");
    await fs.mkdir(workspaceRoot, { recursive: true });

    const ctx = makeContext({
      store,
      workspaces,
      workspaceRoot,
    });
    const next = jest.fn(async () => {});

    await new ChildSessionMiddleware({
      sessionId: "child-5",
      parentSessionId: "parent-1",
      workspaceId: "ws-2",
    }).initialize(ctx, next);

    const workspace = ctx.registry.tryGet(WorkspaceToken);
    expect(workspace).toBeDefined();
    expect(workspace!.workspaceId).toBe("ws-2");
    expect(workspace!.root).toBe(workspaceRoot);
  });
});
