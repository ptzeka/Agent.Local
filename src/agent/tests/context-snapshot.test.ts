import { describe, expect, test, beforeEach, afterEach } from "@jest/globals";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildContextSnapshot,
  hashContextSnapshot,
  saveContextSnapshot,
  getContextSnapshot,
} from "../src/agent/context-loader.js";
import type { ToolDescriptor } from "../src/agent/providers/provider.js";

/**
 * Context-snapshot store tests.
 *
 * The snapshot captures the non-conversation context (system prompt + project
 * direction + tool block) under a content-addressed hash. These cover the
 * three invariants ContextMiddleware leans on: deterministic hashing, write-once
 * dedup, and a faithful round-trip read.
 */

const tool = (name: string): ToolDescriptor => ({
  name,
  description: `desc ${name}`,
  inputSchema: { type: "object" },
});

const baseInput = () => ({
  model: "gemini-3.1-flash-lite",
  systemPrompt: "You are the ORCHESTRATOR.",
  nativeTools: true,
  projectContext: { sourcePath: "/ws/agentcontext.md", content: "do the thing" },
  tools: [tool("read_file"), tool("list_dir")],
});

describe("buildContextSnapshot / hashContextSnapshot", () => {
  test("sorts tools by name so iteration order doesn't change the hash", () => {
    const a = buildContextSnapshot(baseInput());
    const b = buildContextSnapshot({ ...baseInput(), tools: [tool("list_dir"), tool("read_file")] });

    expect(a.tools.map((t) => t.name)).toEqual(["list_dir", "read_file"]);
    expect(hashContextSnapshot(a)).toBe(hashContextSnapshot(b));
  });

  test("a changed system prompt yields a different hash", () => {
    const a = buildContextSnapshot(baseInput());
    const b = buildContextSnapshot({ ...baseInput(), systemPrompt: "different" });

    expect(hashContextSnapshot(a)).not.toBe(hashContextSnapshot(b));
  });

  test("null project context is preserved (not coerced)", () => {
    const snapshot = buildContextSnapshot({ ...baseInput(), projectContext: null });
    expect(snapshot.projectContext).toBeNull();
  });
});

describe("saveContextSnapshot / getContextSnapshot", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "ctx-snap-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  test("saves under <hash>.json and round-trips the exact snapshot", async () => {
    const snapshot = buildContextSnapshot(baseInput());
    const hash = await saveContextSnapshot(dir, snapshot);

    expect(hash).toBe(hashContextSnapshot(snapshot));
    await expect(fs.access(path.join(dir, `${hash}.json`))).resolves.toBeUndefined();
    expect(await getContextSnapshot(dir, hash)).toEqual(snapshot);
  });

  test("is write-once: re-saving the same context does not rewrite the file", async () => {
    const snapshot = buildContextSnapshot(baseInput());
    const hash = await saveContextSnapshot(dir, snapshot);

    const target = path.join(dir, `${hash}.json`);
    const firstMtime = (await fs.stat(target)).mtimeMs;

    const hashAgain = await saveContextSnapshot(dir, snapshot);
    const secondMtime = (await fs.stat(target)).mtimeMs;

    expect(hashAgain).toBe(hash);
    expect(secondMtime).toBe(firstMtime); // untouched
  });

  test("returns null for an unknown hash", async () => {
    expect(await getContextSnapshot(dir, "deadbeefdeadbeef")).toBeNull();
  });
});
