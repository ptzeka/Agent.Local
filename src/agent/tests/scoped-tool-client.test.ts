import { describe, expect, jest, test } from "@jest/globals";

import { ScopedToolClient } from "../src/agent/scoped-tool-client.js";
import type { Mcp } from "@agent-local/mcp";
import type { ToolDescriptor } from "@agent-local/mcp/tooldescriptor";

// Path confinement lives in the server (Workspace guard), not here — these cover routing only:
// namespaced calls, tolerant bare-name resolution, and corrective errors for ambiguous/unknown names.

function fakeMcp(
  name: string,
  toolTails: string[],
  required: string[] = [],
): { mcp: Mcp; callTool: jest.Mock } {
  const callTool = jest.fn(async () => ({ isError: false, content: "{}" }));
  const tools: ToolDescriptor[] = toolTails.map((tail) => ({
    name: `${name}__${tail}`,
    description: tail,
    inputSchema: required.length > 0 ? { type: "object", required } : { type: "object" },
  }));
  return {
    mcp: {
      name,
      listTools: () => tools,
      callTool: callTool as unknown as Mcp["callTool"],
      shutdown: async () => {},
    },
    callTool,
  };
}

describe("ScopedToolClient routing", () => {
  test("a namespaced call routes to the correct server with the bare tail", async () => {
    const excel = fakeMcp("excel", ["append_rows", "read_sheet"]);
    const fs = fakeMcp("fsmcp", ["read_file"]);
    const client = new ScopedToolClient([excel.mcp, fs.mcp]);

    const result = await client.callTool("excel__append_rows", { rows: [] });

    expect(result.isError).toBe(false);
    // No timeout set → the server is called with an undefined cancellation signal.
    expect(excel.callTool).toHaveBeenCalledWith("append_rows", { rows: [] }, undefined);
    expect(fs.callTool).not.toHaveBeenCalled();
  });

  test("a bare tool name with exactly one owner routes to that server", async () => {
    const excel = fakeMcp("excel", ["append_rows", "read_sheet"]);
    const client = new ScopedToolClient([excel.mcp]);

    const result = await client.callTool("append_rows", { rows: [] });

    expect(result.isError).toBe(false);
    expect(excel.callTool).toHaveBeenCalledWith("append_rows", { rows: [] }, undefined);
  });

  test("forwards the turn's signal to the server (timeout lives in the server)", async () => {
    const excel = fakeMcp("excel", ["append_rows"]);
    const client = new ScopedToolClient([excel.mcp]);
    const controller = new AbortController();

    await client.callTool("excel__append_rows", { rows: [] }, undefined, controller.signal);

    // The client only routes and forwards; the server wraps this into its own cutoff.
    expect(excel.callTool).toHaveBeenCalledWith("append_rows", { rows: [] }, controller.signal);
  });

  test("an unknown bare name returns a corrective error naming mounted servers", async () => {
    const fs = fakeMcp("fsmcp", ["read_file"]);
    const client = new ScopedToolClient([fs.mcp]);

    const result = await client.callTool("run_shell", {});

    expect(result.isError).toBe(true);
    expect(result.content).toContain("namespaced as <server>__<tool>");
    expect(result.content).toContain("fsmcp");
    expect(fs.callTool).not.toHaveBeenCalled();
  });

  test("a bare name owned by multiple servers is rejected as ambiguous with candidates", async () => {
    const a = fakeMcp("alpha", ["list_items"]);
    const b = fakeMcp("beta", ["list_items"]);
    const client = new ScopedToolClient([a.mcp, b.mcp]);

    const result = await client.callTool("list_items", {});

    expect(result.isError).toBe(true);
    expect(result.content).toContain("alpha__list_items");
    expect(result.content).toContain("beta__list_items");
    expect(a.callTool).not.toHaveBeenCalled();
    expect(b.callTool).not.toHaveBeenCalled();
  });
});

// Presence-only gate: the client confirms declared `required` keys exist before dispatch.
// Value-level validation (types, enums, empty-string) stays server-side.
describe("ScopedToolClient required-presence", () => {
  test("a call missing a required key is rejected at the client and never dispatched", async () => {
    const exec = fakeMcp("writer", ["write_file"], ["path", "content", "mode"]);
    const client = new ScopedToolClient([exec.mcp]);

    const result = await client.callTool("writer__write_file", { path: "x", content: "" });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("missing required field(s): mode");
    expect(exec.callTool).not.toHaveBeenCalled();
  });

  test("all absent required keys are named in one error", async () => {
    const exec = fakeMcp("writer", ["write_file"], ["path", "content", "mode"]);
    const client = new ScopedToolClient([exec.mcp]);

    const result = await client.callTool("writer__write_file", {});

    expect(result.isError).toBe(true);
    expect(result.content).toContain("path, content, mode");
    expect(exec.callTool).not.toHaveBeenCalled();
  });

  test("presence is not non-empty: an empty-string required value passes to the server", async () => {
    const exec = fakeMcp("writer", ["write_file"], ["path", "content", "mode"]);
    const client = new ScopedToolClient([exec.mcp]);

    const result = await client.callTool("writer__write_file", { path: "x", content: "", mode: "" });

    // Empty value is the server's to reject — the client only checks the key exists.
    expect(result.isError).toBe(false);
    expect(exec.callTool).toHaveBeenCalledWith("write_file", { path: "x", content: "", mode: "" }, undefined);
  });

  test("a fully-valid call passes through untouched", async () => {
    const exec = fakeMcp("writer", ["write_file"], ["path", "content", "mode"]);
    const client = new ScopedToolClient([exec.mcp]);

    const result = await client.callTool("writer__write_file", { path: "x", content: "", mode: "overwrite" });

    expect(result.isError).toBe(false);
    expect(exec.callTool).toHaveBeenCalledWith("write_file", { path: "x", content: "", mode: "overwrite" }, undefined);
  });

  test("the presence check also covers tolerant bare-name routing", async () => {
    const exec = fakeMcp("writer", ["write_file"], ["path", "content", "mode"]);
    const client = new ScopedToolClient([exec.mcp]);

    // bare tail, no server prefix — resolution still finds the descriptor whose `required` gates the call
    const result = await client.callTool("write_file", { path: "x", content: "" });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("missing required field(s): mode");
    expect(exec.callTool).not.toHaveBeenCalled();
  });

  test("a tool with no required array dispatches as before", async () => {
    const fs = fakeMcp("fsmcp", ["read_file"]);
    const client = new ScopedToolClient([fs.mcp]);

    const result = await client.callTool("fsmcp__read_file", {});

    expect(result.isError).toBe(false);
    expect(fs.callTool).toHaveBeenCalledWith("read_file", {}, undefined);
  });
});
