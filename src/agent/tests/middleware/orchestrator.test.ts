import { describe, expect, jest, test } from "@jest/globals";

import { Orchestrator } from "../../src/agent/runners/orchestrator.js";
import { OrchestratorMiddleware } from "../../src/agent/runtime/middleware/orchestrator.js";
import { OrchestratorToken } from "../../src/agent/runtime/tokens.js";
import { makeContext } from "./context.js";

/**
 * OrchestratorMiddleware business logic: build the one stateless Orchestrator
 * from the infra deps, with no dependency on any other pipeline step.
 */
describe("OrchestratorMiddleware", () => {
  test("seeds ctx.orchestrator with an Orchestrator and advances", async () => {
    const ctx = makeContext({ toolDescriptors: [] });
    const next = jest.fn(async () => {});
    
    await new OrchestratorMiddleware({ role: "orchestrator"}).initialize(ctx, next);

    expect(ctx.registry.tryGet(OrchestratorToken)).toBeInstanceOf(Orchestrator);
    expect(next).toHaveBeenCalledTimes(1);
  });

  // Negative on ordering: unlike SessionManagerMiddleware, this step reads only
  // infra (registry/tools), so it must build even when identity/session steps
  // have not run — i.e. it can sit anywhere in the pipeline.
  test("builds from a bare context with no identity/session populated", async () => {
    const ctx = makeContext({ toolDescriptors: [] }); // user, session, workspace all undefined

    await new OrchestratorMiddleware({ role: "orchestrator"}).initialize(ctx, jest.fn(async () => {}));

    expect(ctx.registry.tryGet(OrchestratorToken)).toBeInstanceOf(Orchestrator);
  });
});
