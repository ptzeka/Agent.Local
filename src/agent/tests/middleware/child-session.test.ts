import { describe, expect, jest, test } from "@jest/globals";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ChildSessionMiddleware } from "../../src/agent/runtime/middleware/child-session.js";
import type { SessionStore } from "../../src/agent/session/session-store.js";
import { SessionStore as RealSessionStore } from "../../src/agent/session/session-store.js";
import type { WorkspaceRegistry } from "../../src/agent/registries/workspace-registry.js";
import { WorkspaceRegistry as RealWorkspaceRegistry } from "../../src/agent/registries/workspace-registry.js";
import type { Principal } from "../../src/agent/identity/types.js";
import { makeContext } from "./context.js";

/**
 * ChildSessionMiddleware business logic.
 *
 * A sub-session is created fresh with a pre-minted id, inherits the parent's
 * workspace, optionally seeds standing context, stamps the inherited identity,
 * and persists itself for the store/picker.
 */
describe("ChildSessionMiddleware", () => {
  let tempDir: string;
  let store: SessionStore;
  let workspaces: WorkspaceRegistry;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "child-session-mw-"));
    store = RealSessionStore.create(path.join(tempDir, "sessions"));
    workspaces = new RealWorkspaceRegistry(path.join(tempDir, "workspaces"));
  });

  afterEach(async () => {
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
    ).rejects.toThrow("requires ctx.store and ctx.workspaces");
  });

  test("creates a child session with correct ids and persists it", async () => {
    // Register the parent's workspace first
    const workspaceRoot = path.join(tempDir, "workspace");
    await fs.mkdir(workspaceRoot, { recursive: true });
    await workspaces.register("ws-1", workspaceRoot);

    const ctx = makeContext({
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

    expect(ctx.session).toBeDefined();
    expect(ctx.session!.sessionId).toBe("child-1");
    expect(ctx.session!.parentSessionId).toBe("parent-1");
    expect(ctx.session!.workspaceId).toBe("ws-1");
    expect(ctx.workspace).toBeDefined();
    expect(ctx.workspace!.workspaceId).toBe("ws-1");
    expect(next).toHaveBeenCalledTimes(1);

    // Verify the session was persisted
    const persisted = await store.load("child-1");
    expect(persisted?.sessionId).toBe("child-1");
    expect(persisted?.parentSessionId).toBe("parent-1");
  });

  test("seeds standing context when provided", async () => {
    const workspaceRoot = path.join(tempDir, "workspace");
    await fs.mkdir(workspaceRoot, { recursive: true });
    await workspaces.register("ws-1", workspaceRoot);

    const standingContext = "Previous work: Fixed authentication bugs";
    const ctx = makeContext({
      store,
      workspaces,
      workspaceRoot,
    });
    const next = jest.fn(async () => {});

    await new ChildSessionMiddleware({
      sessionId: "child-2",
      parentSessionId: "parent-1",
      workspaceId: "ws-1",
      standingContext,
    }).initialize(ctx, next);

    expect(ctx.session!.conversation.length).toBe(1);
    expect(ctx.session!.conversation[0].role).toBe("system");
    expect(ctx.session!.conversation[0].content).toContain(standingContext);
  });

  test("ignores empty or whitespace-only standing context", async () => {
    const workspaceRoot = path.join(tempDir, "workspace");
    await fs.mkdir(workspaceRoot, { recursive: true });
    await workspaces.register("ws-1", workspaceRoot);

    const ctx = makeContext({
      store,
      workspaces,
      workspaceRoot,
    });
    const next = jest.fn(async () => {});

    await new ChildSessionMiddleware({
      sessionId: "child-3",
      parentSessionId: "parent-1",
      workspaceId: "ws-1",
      standingContext: "   \n  \t  ",
    }).initialize(ctx, next);

    expect(ctx.session!.conversation.length).toBe(0);
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

    expect(ctx.session!.user).toBe(user);
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

    expect(ctx.workspace).toBeDefined();
    expect(ctx.workspace!.workspaceId).toBe("ws-2");
    expect(ctx.workspace!.root).toBe(workspaceRoot);
  });
});
