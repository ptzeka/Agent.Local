import { describe, expect, test } from "@jest/globals";

import { LocalMcp } from "../local-mcp.js";
import { enforceOutputContract } from "../output-contract.js";
import type { ToolOutputSchema } from "../tooldescriptor.js";

const schema: ToolOutputSchema = {
  required: ["status", "reason"],
  properties: {
    status: { enum: ["pass", "fail"] },
    reason: { default: "(none given)" },
  },
};

describe("enforceOutputContract", () => {
  test("no schema leaves the result byte-identical", () => {
    const result = { isError: false, content: "free prose" };
    expect(enforceOutputContract(result, undefined)).toBe(result);
  });

  test("a conforming body is rewritten to the parsed record", () => {
    const out = enforceOutputContract(
      { isError: false, content: 'noise ```json {"status":"pass","reason":"ok"} ``` trailing' },
      schema
    );
    expect(out.isError).toBe(false);
    expect(JSON.parse(out.content)).toEqual({ status: "pass", reason: "ok" });
  });

  test("a declared default fills a missing field instead of failing", () => {
    const out = enforceOutputContract({ isError: false, content: '{"status":"fail"}' }, schema);
    expect(out.isError).toBe(false);
    expect(JSON.parse(out.content).reason).toBe("(none given)");
  });

  test("an out-of-enum value fails and names the field", () => {
    const out = enforceOutputContract({ isError: false, content: '{"status":"maybe","reason":"x"}' }, schema);
    expect(out.isError).toBe(true);
    expect(out.content).toContain("status");
  });

  test("an already-failed call keeps the server's own wording", () => {
    const out = enforceOutputContract({ isError: true, content: "[dispatch-error] boom" }, schema);
    expect(out.content).toBe("[dispatch-error] boom");
  });

  test("usage survives the gate", () => {
    const out = enforceOutputContract(
      { isError: false, content: '{"status":"pass","reason":"ok"}', usage: { inputTokens: 1, outputTokens: 2 } },
      schema
    );
    expect(out.usage).toEqual({ inputTokens: 1, outputTokens: 2 });
  });
});

describe("LocalMcp.callTool", () => {
  const server = new LocalMcp("agent", [
    {
      descriptor: { name: "dispatch", description: "", inputSchema: { type: "object" }, outputSchema: schema },
      invoke: async (args) => ({ isError: false, content: String(args.answer ?? "") }),
    },
    {
      descriptor: { name: "plain", description: "", inputSchema: { type: "object" } },
      invoke: async () => ({ isError: false, content: "untouched prose" }),
    },
  ]);

  test("gates a declaring tool's response", async () => {
    const bad = await server.callTool("dispatch", { answer: '{"status":"nope","reason":"x"}' });
    expect(bad.isError).toBe(true);
    const good = await server.callTool("dispatch", { answer: '{"status":"pass","reason":"x"}' });
    expect(good.isError).toBe(false);
  });

  test("leaves a tool without an outputSchema alone", async () => {
    const out = await server.callTool("plain", {});
    expect(out).toEqual({ isError: false, content: "untouched prose" });
  });

  test("advertises the declared outputSchema", () => {
    const [dispatch, plain] = server.listTools();
    expect(dispatch.outputSchema).toEqual(schema);
    expect(plain.outputSchema).toBeUndefined();
  });
});
