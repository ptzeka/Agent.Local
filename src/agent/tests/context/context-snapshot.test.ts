import { describe, expect, test, beforeEach, afterEach } from "@jest/globals";

import { ContextLoader } from "../../src/agent/context/context-loader.js";
import type { DatabaseHandle } from "@agent-local/common/db";
import type { ToolDescriptor } from "@agent-local/mcp/tooldescriptor";
import { makeTestDb } from "../middleware/context.js";

// The snapshot captures non-conversation context (system prompt + project direction + tool block) under a
// content-addressed hash. These cover what ContextMiddleware leans on: deterministic hashing keyed on the
// captured inputs, write-once dedup, and a faithful round-trip read.

const tool = (name: string): ToolDescriptor => ({
  name,
  description: `desc ${name}`,
  inputSchema: { type: "object" },
});

const ROLE = "orchestrator";
const SYSTEM_PROMPT = "You are the ORCHESTRATOR.";
const PROJECT_CONTEXT = "do the thing";
const TOOLS = [tool("read_file"), tool("list_dir")];

describe("ContextLoader.buildContext / hashContextSnapshot", () => {
  // The DB is irrelevant for pure build/hash work — only save/get touch it.
  const loader = ContextLoader.create(makeTestDb());

  test("captures the build inputs verbatim", () => {
    const snapshot = loader.buildContext(ROLE, SYSTEM_PROMPT, PROJECT_CONTEXT, TOOLS);

    expect(snapshot.role).toBe(ROLE);
    expect(snapshot.systemPrompt).toBe(SYSTEM_PROMPT);
    expect(snapshot.projectContext).toBe(PROJECT_CONTEXT);
    expect(snapshot.tools.map((t) => t.name)).toEqual(["read_file", "list_dir"]);
  });

  test("the same inputs hash identically", () => {
    const a = loader.buildContext(ROLE, SYSTEM_PROMPT, PROJECT_CONTEXT, TOOLS);
    const b = loader.buildContext(ROLE, SYSTEM_PROMPT, PROJECT_CONTEXT, TOOLS);

    expect(loader.hashContextSnapshot(a)).toBe(loader.hashContextSnapshot(b));
  });

  test("a changed system prompt yields a different hash", () => {
    const a = loader.buildContext(ROLE, SYSTEM_PROMPT, PROJECT_CONTEXT, TOOLS);
    const b = loader.buildContext(ROLE, "different", PROJECT_CONTEXT, TOOLS);

    expect(loader.hashContextSnapshot(a)).not.toBe(loader.hashContextSnapshot(b));
  });

  test("a changed tool set yields a different hash", () => {
    const a = loader.buildContext(ROLE, SYSTEM_PROMPT, PROJECT_CONTEXT, TOOLS);
    const b = loader.buildContext(ROLE, SYSTEM_PROMPT, PROJECT_CONTEXT, [tool("read_file")]);

    expect(loader.hashContextSnapshot(a)).not.toBe(loader.hashContextSnapshot(b));
  });
});

describe("ContextLoader.saveContextSnapshot / getContextSnapshot", () => {
  let db: DatabaseHandle;
  let loader: ContextLoader;

  beforeEach(() => {
    db = makeTestDb();
    loader = ContextLoader.create(db);
  });

  afterEach(() => {
    db.close();
  });

  // reads the row's stamp straight from the table to prove write-once semantics
  function createdAt(hash: string): number | undefined {
    return (db.prepare("SELECT created_at FROM contexts WHERE hash = ?").get(hash) as { created_at: number } | undefined)
      ?.created_at;
  }

  test("saves under its hash and round-trips the exact snapshot", async () => {
    const snapshot = loader.buildContext(ROLE, SYSTEM_PROMPT, PROJECT_CONTEXT, TOOLS);
    const hash = await loader.saveContextSnapshot(snapshot);

    expect(hash).toBe(loader.hashContextSnapshot(snapshot));
    expect(createdAt(hash)).toBeGreaterThan(0);
    expect(await loader.getContextSnapshot(hash)).toEqual(snapshot);
  });

  test("is write-once: re-saving the same context leaves the existing row untouched", async () => {
    const snapshot = loader.buildContext(ROLE, SYSTEM_PROMPT, PROJECT_CONTEXT, TOOLS);
    const hash = await loader.saveContextSnapshot(snapshot);
    const firstStamp = createdAt(hash);

    const hashAgain = await loader.saveContextSnapshot(snapshot);

    expect(hashAgain).toBe(hash);
    expect(createdAt(hash)).toBe(firstStamp); // INSERT OR IGNORE did not overwrite
  });

  test("returns null for an unknown hash", async () => {
    expect(await loader.getContextSnapshot("deadbeefdeadbeef")).toBeNull();
  });
});
