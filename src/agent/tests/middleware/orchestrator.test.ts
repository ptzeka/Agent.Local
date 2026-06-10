import { describe, expect, jest, test } from "@jest/globals";

import { Orchestrator } from "../../src/agent/orchestrator.js";
import { OrchestratorMiddleware } from "../../src/agent/runtime/middleware/orchestrator.js";
import { makeContext } from "./context.js";

/**
 * OrchestratorMiddleware business logic: build the one stateless Orchestrator
 * from the infra deps, with no dependency on any other pipeline step.
 */
describe("OrchestratorMiddleware", () => {
  test("seeds ctx.orchestrator with an Orchestrator and advances", async () => {
    const ctx = makeContext({ toolDescriptors: [] });
    const next = jest.fn(async () => {});

    await new OrchestratorMiddleware().initialize(ctx, next);

    expect(ctx.orchestrator).toBeInstanceOf(Orchestrator);
    expect(next).toHaveBeenCalledTimes(1);
  });

  // Negative on ordering: unlike SessionManagerMiddleware, this step reads only
  // infra (registry/tools), so it must build even when identity/session steps
  // have not run — i.e. it can sit anywhere in the pipeline.
  test("builds from a bare context with no identity/session populated", async () => {
    const ctx = makeContext({ toolDescriptors: [] }); // user, session, workspace all undefined

    await new OrchestratorMiddleware().initialize(ctx, jest.fn(async () => {}));

    expect(ctx.orchestrator).toBeInstanceOf(Orchestrator);
  });
});
