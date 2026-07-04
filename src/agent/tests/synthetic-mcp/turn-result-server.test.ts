import { describe, expect, test } from "@jest/globals";

import { TurnResultLocalMcp } from "../../src/agent/synthetic-mcp/turn-result-server.js";
import { TurnResultCapture } from "../../src/agent/synthetic-mcp/turn-result-tools.js";
import type { ToolContext } from "../../src/agent/synthetic-mcp/types.js";

// report_result is the agent's enforced terminal action on a dispatched turn: it must hand a parseable verdict
// (status + structured result) to the turn-scoped sink the orchestrator binds, so a "fail" verdict can fail the
// step even when the turn ran honestly. The contract under test is that capture, not any LLM behavior.

function makeServer(sink?: TurnResultCapture): TurnResultLocalMcp {
  const server = new TurnResultLocalMcp({
    session: {},
    workspace: {},
    sandboxRoot: "/tmp/sandbox",
  } as unknown as ToolContext);
  if (sink) server.bindTurn({ resultSink: sink });
  return server;
}

describe("turnresult server", () => {
  test("advertises exactly report_result, namespaced", () => {
    const server = makeServer(new TurnResultCapture());
    expect(server.listTools().map((tool) => tool.name)).toEqual(["turnresult__report_result"]);
  });

  test("captures a success verdict and its structured result into the sink", async () => {
    const sink = new TurnResultCapture();
    const server = makeServer(sink);

    const out = await server.callTool("report_result", { status: "success", result: { rows: 3 } });

    expect(out.isError).toBe(false);
    expect(sink.value).toEqual({ status: "success", result: { rows: 3 } });
  });

  test("captures a fail verdict — an honest negative answer is still a recorded result", async () => {
    const sink = new TurnResultCapture();
    const server = makeServer(sink);

    await server.callTool("report_result", { status: "fail", result: { holds: false, detail: "row missing" } });

    expect(sink.value).toEqual({ status: "fail", result: { holds: false, detail: "row missing" } });
  });

  test("rejects a status outside the enum and leaves the sink empty (no false verdict banked)", async () => {
    const sink = new TurnResultCapture();
    const server = makeServer(sink);

    const out = await server.callTool("report_result", { status: "done", result: {} });

    expect(out.isError).toBe(true);
    expect(sink.value).toBeUndefined();
  });

  test("errors when no sink is bound (the tool wasn't meant to be reachable off a dispatched turn)", async () => {
    const server = makeServer(undefined);

    const out = await server.callTool("report_result", { status: "success", result: {} });

    expect(out.isError).toBe(true);
  });

  test("a fresh bindTurn swaps the sink, so a previous turn's capture never receives this turn's verdict", async () => {
    const staleSink = new TurnResultCapture();
    const liveSink = new TurnResultCapture();
    const server = makeServer(staleSink);
    server.bindTurn({ resultSink: liveSink });

    await server.callTool("report_result", { status: "success", result: { turn: 2 } });

    expect(staleSink.value).toBeUndefined();
    expect(liveSink.value).toEqual({ status: "success", result: { turn: 2 } });
  });
});
