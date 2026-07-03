import { describe, expect, test } from "@jest/globals";

import { parseArgs } from "../src/cli/args.js";

// pure input → output: the recognised flags across --flag value and --flag=value forms, plus the
// no-flag (interactive) default and value-handling edge cases
describe("parseArgs", () => {
  test("no flags ⇒ interactive (run undefined)", () => {
    const args = parseArgs([]);
    expect(args.run).toBeUndefined();
    expect(args.sessionId).toBeUndefined();
  });

  test("--run with a space-separated value", () => {
    const args = parseArgs(["--run", "refactor foo.ts"]);
    expect(args.run).toBe("refactor foo.ts");
    expect(args.sessionId).toBeUndefined();
  });

  test("--run and --session together", () => {
    const args = parseArgs(["--run", "do X", "--session", "abc-123"]);
    expect(args.run).toBe("do X");
    expect(args.sessionId).toBe("abc-123");
  });

  test("--flag=value form is accepted", () => {
    const args = parseArgs(["--run=do Y", "--session=sess-9"]);
    expect(args.run).toBe("do Y");
    expect(args.sessionId).toBe("sess-9");
  });

  test("order is irrelevant", () => {
    const args = parseArgs(["--session", "s1", "--run", "task"]);
    expect(args.run).toBe("task");
    expect(args.sessionId).toBe("s1");
  });

  test("--run with no following value defaults to empty string (still headless)", () => {
    const args = parseArgs(["--run"]);
    expect(args.run).toBe("");
  });

  test("--run does not swallow a following flag as its value", () => {
    const args = parseArgs(["--run", "--session", "s2"]);
    // "--session" is a flag, not the run value, so run is empty and session set.
    expect(args.run).toBe("");
    expect(args.sessionId).toBe("s2");
  });

  test("--token in both forms; absent stays undefined", () => {
    expect(parseArgs(["--token", "abc.def.ghi"]).token).toBe("abc.def.ghi");
    expect(parseArgs(["--token=abc.def.ghi"]).token).toBe("abc.def.ghi");
    expect(parseArgs(["--run", "go"]).token).toBeUndefined();
  });

  test("--token with no following value is ignored", () => {
    const args = parseArgs(["--token", "--run", "go"]);
    expect(args.token).toBeUndefined();
    expect(args.run).toBe("go");
  });

  test("unknown flags are ignored", () => {
    const args = parseArgs(["--verbose", "--run", "go"]);
    expect(args.run).toBe("go");
  });
});
