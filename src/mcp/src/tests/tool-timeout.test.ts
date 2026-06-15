import { describe, expect, test } from "@jest/globals";

import type { ToolExecutionResult } from "@agent-local/mcp";
import { LocalMcp, type LocalTool } from "@agent-local/mcp";
import { CancellationToken } from "@agent-local/common/lifetime";

const ok: ToolExecutionResult = { isError: false, content: "ok" };

function tool(name: string, invoke: LocalTool["invoke"]): LocalTool {
  return {
    descriptor: { name, description: "", inputSchema: { type: "object" } },
    invoke,
  };
}

describe("LocalMcp.callTool (server-owned timeout)", () => {
  test("hands the tool a CancellationToken derived from the caller's signal", async () => {
    let seen: CancellationToken | undefined;
    const mcp = new LocalMcp("svc", [tool("probe", async (_args, cutoff) => ((seen = cutoff), ok))]);

    const controller = new AbortController();
    const result = await mcp.callTool("probe", {}, controller.signal);

    expect(result).toEqual(ok);
    // A cancel from above collapses the call's cutoff token.
    expect(seen?.cancelled).toBe(false);
    controller.abort();
    expect(seen?.cancelled).toBe(true);
  });

  test("with no timeout the token never auto-cancels", async () => {
    let seen: CancellationToken | undefined;
    const mcp = new LocalMcp("svc", [tool("probe", async (_args, cutoff) => ((seen = cutoff), ok))]);

    await mcp.callTool("probe", {});
    await new Promise((r) => setTimeout(r, 10));
    expect(seen?.cancelled).toBe(false);
  });

  test("the injected timeout cancels the call's token after the bound", async () => {
    // A cooperative tool that waits on its cutoff and reports back when it fires.
    const mcp = new LocalMcp("svc", [
      tool("hang", (_args, cutoff) =>
        new Promise<ToolExecutionResult>((resolve) => {
          cutoff.signal.addEventListener(
            "abort",
            () => resolve({ isError: true, content: "aborted" }),
            { once: true }
          );
        })
      ),
    ]).setTimeout(20);

    const result = await mcp.callTool("hang", {});
    expect(result).toEqual({ isError: true, content: "aborted" });
  });

  test("a timeout of 0 disables the bound", async () => {
    let seen: CancellationToken | undefined;
    const mcp = new LocalMcp("svc", [tool("probe", async (_args, cutoff) => ((seen = cutoff), ok))]).setTimeout(0);

    await mcp.callTool("probe", {});
    await new Promise((r) => setTimeout(r, 10));
    expect(seen?.cancelled).toBe(false);
  });

  test("a thrown tool is still shaped into an error result", async () => {
    const mcp = new LocalMcp("svc", [
      tool("boom", async () => {
        throw new Error("kaboom");
      }),
    ]);
    const result = await mcp.callTool("boom", {});
    expect(result.isError).toBe(true);
    expect(result.content).toContain("kaboom");
  });
});
