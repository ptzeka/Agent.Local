import { describe, expect, test } from "@jest/globals";

import { createTurnResultLocalMcp } from "../../src/agent/synthetic-mcp/turn-result-server.js";
import { TurnResultCapture } from "../../src/agent/synthetic-mcp/turn-result-tools.js";
import type { ToolContext } from "../../src/agent/synthetic-mcp/types.js";

// report_result is the agent's enforced terminal action on a dispatched turn: it must hand a parseable verdict
// (status + structured result) to the turn-scoped sink the orchestrator reads, so a "fail" verdict can fail the
// step even when the turn ran honestly. The contract under test is that capture, not any LLM behavior.

function makeContext(sink?: TurnResultCapture): ToolContext {
  return {
    session: {},
    workspace: {},
    sandboxRoot: "/tmp/sandbox",
    coordinator: undefined,
    signal: undefined,
    resultSink: sink,
  } as unknown as ToolContext;
}

describe("turnresult server", () => {
  test("advertises exactly report_result, namespaced", () => {
    const server = createTurnResultLocalMcp(makeContext(new TurnResultCapture()));
    expect(server.listTools().map((tool) => tool.name)).toEqual(["turnresult__report_result"]);
  });

  test("captures a success verdict and its structured result into the sink", async () => {
    const sink = new TurnResultCapture();
    const server = createTurnResultLocalMcp(makeContext(sink));

    const out = await server.callTool("report_result", { status: "success", result: { rows: 3 } });

    expect(out.isError).toBe(false);
    expect(sink.value).toEqual({ status: "success", result: { rows: 3 } });
  });

  test("captures a fail verdict — an honest negative answer is still a recorded result", async () => {
    const sink = new TurnResultCapture();
    const server = createTurnResultLocalMcp(makeContext(sink));

    await server.callTool("report_result", { status: "fail", result: { holds: false, detail: "row missing" } });

    expect(sink.value).toEqual({ status: "fail", result: { holds: false, detail: "row missing" } });
  });

  test("rejects a status outside the enum and leaves the sink empty (no false verdict banked)", async () => {
    const sink = new TurnResultCapture();
    const server = createTurnResultLocalMcp(makeContext(sink));

    const out = await server.callTool("report_result", { status: "done", result: {} });

    expect(out.isError).toBe(true);
    expect(sink.value).toBeUndefined();
  });

  test("errors when no sink is bound (the tool wasn't meant to be reachable off a dispatched turn)", async () => {
    const server = createTurnResultLocalMcp(makeContext(undefined));

    const out = await server.callTool("report_result", { status: "success", result: {} });

    expect(out.isError).toBe(true);
  });
});
