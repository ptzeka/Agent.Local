import { describe, expect, jest, test } from "@jest/globals";

import { SessionManagerMiddleware } from "../../src/agent/runtime/middleware/session-manager.js";
import { SessionManagerToken } from "../../src/agent/runtime/tokens.js";
import type { Workspace } from "../../src/agent/registries/workspace-registry.js";
import { createSession } from "../../src/agent/session/session.js";
import { makeContext } from "./context.js";

// the manager folds settled children's token tally into this session, so the step requires one
const session = createSession({ sessionId: "s1", workspaceId: "ws-1", conversationId: "c1" });

/**
 * SessionManagerMiddleware business logic.
 *
 * Contract change: the manager used to compose the parent's orchestrator + inbox
 * + store, so the middleware refused to build without all three. It now
 * provisions each child by building a whole sub-runtime from an injected
 * factory, so it depends only on that factory — there is no half-wired state to
 * guard against, and the step always seeds the manager. These cover the new
 * shape: the manager is always built, and a cap-0 (leaf) manager enforces the
 * one-level-deep guard by rejecting every spawn.
 */
describe("SessionManagerMiddleware", () => {
  test("always seeds ctx.sessionManager and continues the pipeline", async () => {
    const ctx = makeContext({ session });
    const next = jest.fn(async () => {});

    await new SessionManagerMiddleware().initialize(ctx, next);

    expect(ctx.registry.tryGet(SessionManagerToken)).toBeDefined();
    expect(next).toHaveBeenCalledTimes(1);
  });

  test("a leaf manager (maxActivePerParent: 0) refuses every spawn — the one-level guard", async () => {
    const ctx = makeContext({ session });

    await new SessionManagerMiddleware({ maxActivePerParent: 0 }).initialize(ctx, async () => {});

    const result = ctx.registry.get(SessionManagerToken).createSubSession({
      parentSessionId: "parent",
      workspace: {} as Workspace,
      intent: "do a self-contained thing",
    });

    expect(result.outcome).toBe("rejected");
    expect(result.snapshot).toBeNull();
  });
});
