import { describe, expect, test } from "@jest/globals";

import { DISPATCH_TOOL, RoleDispatchLocalMcp } from "../../src/agent/synthetic-mcp/role-dispatch-server.js";
import { DispatchTracker } from "../../src/agent/synthetic-mcp/dispatch-tracker.js";
import type { RuntimeContext } from "../../src/agent/runtime/types.js";

// every assertion here stops at admission, which runs before any child runtime is built — so the context
// is never dereferenced and a bare stub is enough to exercise the gate
const stubContext = {} as unknown as RuntimeContext;

const server = (dispatch: { description: string; cap?: number }) =>
  new RoleDispatchLocalMcp(stubContext, "filesagent", dispatch, "filesagent", DISPATCH_TOOL);

describe("RoleDispatchLocalMcp", () => {
  test("advertises the role's description under <role>__ask", () => {
    const [tool] = server({ description: "ask the files agent" }).listTools();

    expect(tool.name).toBe("filesagent__ask");
    expect(tool.description).toBe("ask the files agent");
    expect(tool.inputSchema?.required).toEqual(["ask"]);
  });

  test("an empty ask is refused before anything is spawned", async () => {
    const result = await server({ description: "ask" }).callTool(DISPATCH_TOOL, { ask: "" });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("ask is required");
  });

  test("the role's own cap bounds how many times one turn may call it", async () => {
    const agent = server({ description: "ask", cap: 1 });
    agent.bindTurn({ tracker: new DispatchTracker(99, 0) });

    // the first call is admitted and goes on to build a child, which the bare context cannot satisfy —
    // that it FAILED rather than being BLOCKED is the distinction under test
    const admitted = await agent.callTool(DISPATCH_TOOL, { ask: "find the notes" });
    expect(admitted.content).not.toContain("[dispatch-blocked]");

    const refused = await agent.callTool(DISPATCH_TOOL, { ask: "find something else" });
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain("[dispatch-blocked]");
    expect(refused.content).toContain("filesagent");
  });

  test("without a cap of its own the agent falls back to the turn-wide default", async () => {
    const agent = server({ description: "ask" });
    agent.bindTurn({ tracker: new DispatchTracker(1, 0) });

    await agent.callTool(DISPATCH_TOOL, { ask: "first" });
    const refused = await agent.callTool(DISPATCH_TOOL, { ask: "second" });

    expect(refused.content).toContain("[dispatch-blocked]");
  });

  // an unbound agent is a leaf's own run, where there is no turn to account against
  test("an unbound agent is unaccounted rather than blocked", async () => {
    const agent = server({ description: "ask", cap: 0 });

    const result = await agent.callTool(DISPATCH_TOOL, { ask: "anything" });

    expect(result.content).not.toContain("[dispatch-blocked]");
  });
});
