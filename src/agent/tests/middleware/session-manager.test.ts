import { describe, expect, jest, test } from "@jest/globals";

import { SessionManagerMiddleware } from "../../src/agent/runtime/middleware/session-manager.js";
import { MetricsRegistryToken, SessionManagerToken } from "../../src/agent/runtime/tokens.js";
import { MetricsRegistry } from "../../src/agent/runtime/metrics/metrics-registry.js";
import { MetricsStore } from "../../src/agent/runtime/metrics/metrics-store.js";
import type { Workspace } from "../../src/agent/registries/workspace-registry.js";
import { createSession } from "../../src/agent/session/session.js";
import { makeContext } from "./context.js";
import type { RuntimeContext } from "../../src/agent/runtime/types.js";

const session = createSession({ sessionId: "s1", workspaceId: "ws-1", conversationId: "c1" });

// the manager folds settled children's spend into the runtime's MetricsRegistry, so the real pipeline
// registers it before this step; seed it here to mirror that ordering
function seedMetrics(ctx: RuntimeContext): void {
  ctx.registry.set(
    MetricsRegistryToken,
    new MetricsRegistry({ sessionId: session.sessionId, store: new MetricsStore() })
  );
}

// the manager now provisions each child by building a whole sub-runtime from an injected factory, so it
// depends only on that factory and the step always seeds it. These cover that shape: the manager is always
// built, and a cap-0 (leaf) manager enforces the one-level-deep guard by rejecting every spawn.
describe("SessionManagerMiddleware", () => {
  test("always seeds ctx.sessionManager and continues the pipeline", async () => {
    const ctx = makeContext({ session });
    seedMetrics(ctx);
    const next = jest.fn(async () => {});

    await new SessionManagerMiddleware().initialize(ctx, next);

    expect(ctx.registry.tryGet(SessionManagerToken)).toBeDefined();
    expect(next).toHaveBeenCalledTimes(1);
  });

  test("a leaf manager (maxActivePerParent: 0) refuses every spawn — the one-level guard", async () => {
    const ctx = makeContext({ session });
    seedMetrics(ctx);

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
