import { describe, expect, test, beforeEach, afterEach } from "@jest/globals";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ContextLoader } from "../../src/agent/context/context-loader.js";
import type { ToolDescriptor } from "../../src/agent/providers/provider.js";

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
  // The contexts dir is irrelevant for pure build/hash work — only save/get touch disk.
  const loader = new ContextLoader(os.tmpdir());

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
  let dir: string;
  let loader: ContextLoader;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "ctx-snap-"));
    loader = new ContextLoader(dir);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  test("saves under <hash>.json and round-trips the exact snapshot", async () => {
    const snapshot = loader.buildContext(ROLE, SYSTEM_PROMPT, PROJECT_CONTEXT, TOOLS);
    const hash = await loader.saveContextSnapshot(snapshot);

    expect(hash).toBe(loader.hashContextSnapshot(snapshot));
    await expect(fs.access(path.join(dir, `${hash}.json`))).resolves.toBeUndefined();
    expect(await loader.getContextSnapshot(hash)).toEqual(snapshot);
  });

  test("is write-once: re-saving the same context does not rewrite the file", async () => {
    const snapshot = loader.buildContext(ROLE, SYSTEM_PROMPT, PROJECT_CONTEXT, TOOLS);
    const hash = await loader.saveContextSnapshot(snapshot);

    const target = path.join(dir, `${hash}.json`);
    const firstMtime = (await fs.stat(target)).mtimeMs;

    const hashAgain = await loader.saveContextSnapshot(snapshot);
    const secondMtime = (await fs.stat(target)).mtimeMs;

    expect(hashAgain).toBe(hash);
    expect(secondMtime).toBe(firstMtime); // untouched
  });

  test("returns null for an unknown hash", async () => {
    expect(await loader.getContextSnapshot("deadbeefdeadbeef")).toBeNull();
  });
});
