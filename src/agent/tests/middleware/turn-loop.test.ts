import { describe, expect, jest, test } from "@jest/globals";

import { TurnLoop } from "../../src/agent/runners/turn-loop.js";
import { TurnLoopMiddleware } from "../../src/agent/runtime/middleware/turn-loop.js";
import { TurnLoopToken } from "../../src/agent/runtime/tokens.js";
import { makeContext } from "./context.js";

// builds the one stateless TurnLoop from the infra deps, with no dependency on any other pipeline step
describe("TurnLoopMiddleware", () => {
  test("seeds ctx.orchestrator with an TurnLoop and advances", async () => {
    const ctx = makeContext({ toolDescriptors: [] });
    const next = jest.fn(async () => {});
    
    await new TurnLoopMiddleware({ role: "orchestrator"}).initialize(ctx, next);

    expect(ctx.registry.tryGet(TurnLoopToken)).toBeInstanceOf(TurnLoop);
    expect(next).toHaveBeenCalledTimes(1);
  });

  // Negative on ordering: unlike the MCP step, this step reads only
  // infra (registry/tools), so it must build even when identity/session steps
  // have not run — i.e. it can sit anywhere in the pipeline.
  test("builds from a bare context with no identity/session populated", async () => {
    const ctx = makeContext({ toolDescriptors: [] }); // user, session, workspace all undefined

    await new TurnLoopMiddleware({ role: "orchestrator"}).initialize(ctx, jest.fn(async () => {}));

    expect(ctx.registry.tryGet(TurnLoopToken)).toBeInstanceOf(TurnLoop);
  });
});
