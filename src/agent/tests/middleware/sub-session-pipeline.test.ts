import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Principal } from "../../src/agent/identity/types.js";
import { ChildSessionMiddleware } from "../../src/agent/runtime/middleware/child-session.js";
import { ConversationMiddleware } from "../../src/agent/runtime/middleware/conversation.js";
import { InheritedUserMiddleware } from "../../src/agent/runtime/middleware/inherited-user.js";
import { StoreMiddleware } from "../../src/agent/runtime/middleware/store.js";
import { WorkspaceRegistryMiddleware } from "../../src/agent/runtime/middleware/workspace-registry.js";
import {
  ConversationToken,
  SessionToken,
  StoreToken,
  UserToken,
  WorkspaceToken,
} from "../../src/agent/runtime/tokens.js";
import { makeContext } from "./context.js";

// the two provisioning steps a sub-runtime swaps in for the top-level pipeline: inherit the parent's identity
// instead of authenticating, and mint a fresh parent-linked child session instead of opening/resuming from disk

const noop = async () => {};
const PARENT_USER = {
  sub: "alice",
  isAuthenticated: true,
  claims: {},
  scopes: [],
} as Principal;

describe("InheritedUserMiddleware", () => {
  test("adopts the parent's principal onto ctx.user", async () => {
    const ctx = makeContext();
    const next = jest.fn(noop);

    await new InheritedUserMiddleware(PARENT_USER).initialize(ctx, next);

    expect(ctx.registry.tryGet(UserToken)).toBe(PARENT_USER);
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe("ChildSessionMiddleware", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "childsess-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  // runs Store → WorkspaceRegistry → InheritedUser → ChildSession → Conversation over a temp-dir context,
  // exactly as buildSubRuntime orders them
  async function provision(options: { standingContext?: string } = {}) {
    const ctx = makeContext({ workspaceRoot: root, sessionsDir: path.join(root, "sessions") });
    await new StoreMiddleware().initialize(ctx, noop);
    await new WorkspaceRegistryMiddleware().initialize(ctx, noop);
    await new InheritedUserMiddleware(PARENT_USER).initialize(ctx, noop);
    await new ChildSessionMiddleware({
      sessionId: "child-1",
      parentSessionId: "parent-1",
      workspaceId: "ws-1",
    }).initialize(ctx, noop);
    await new ConversationMiddleware({ standingContext: options.standingContext }).initialize(
      ctx,
      noop
    );
    return ctx;
  }

  test("mints a parent-linked child with inherited identity and resolved workspace", async () => {
    const ctx = await provision();

    const session = ctx.registry.get(SessionToken);
    expect(session.sessionId).toBe("child-1");
    expect(session.parentSessionId).toBe("parent-1");
    expect(session.workspaceId).toBe("ws-1");
    expect(session.user).toBe(PARENT_USER);
    expect(ctx.registry.get(WorkspaceToken).workspaceId).toBe("ws-1");
  });

  test("seeds the standing context as a leading system message", async () => {
    const ctx = await provision({ standingContext: "be terse" });

    const first = ctx.registry.get(ConversationToken).getMessages()[0];
    expect(first.role).toBe("system");
    expect(first.content).toContain("be terse");
  });

  test("with no standing context the conversation starts empty", async () => {
    const ctx = await provision();
    expect(ctx.registry.get(ConversationToken).length).toBe(0);
  });

  test("persists the child session to the store under its id", async () => {
    const ctx = await provision();
    const loaded = await ctx.registry.get(StoreToken).load("child-1");
    expect(loaded?.parentSessionId).toBe("parent-1");
  });
});
