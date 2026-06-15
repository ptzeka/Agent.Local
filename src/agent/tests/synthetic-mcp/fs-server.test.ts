import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createFsLocalMcp } from "../../src/agent/synthetic-mcp/fs-server.js";
import type { LocalMcp } from "@agent-local/mcp";

// In-process fsmcp LocalMcp (no SDK Server/transport), driven through the Mcp surface: listTools()
// advertises namespaced descriptors, callTool() takes the bare name and returns a { isError, content }
// envelope. IO must stay confined to the injected sandbox root.

describe("createFsLocalMcp", () => {
  let root: string;
  let server: LocalMcp;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "fs-server-"));
    server = createFsLocalMcp(root);
  });

  afterEach(async () => {
    await server.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  });

  test("advertises the seven fs tools namespaced under fsmcp", () => {
    const tools = server.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "fsmcp__delete_file",
      "fsmcp__edit_file",
      "fsmcp__glob",
      "fsmcp__grep",
      "fsmcp__list_dir",
      "fsmcp__read_file",
      "fsmcp__write_file",
    ]);
    // inputSchema is real JSON Schema derived from the Zod schema.
    const readFile = tools.find((t) => t.name === "fsmcp__read_file");
    expect(readFile?.inputSchema).toMatchObject({ type: "object" });
  });

  test("write_file then read_file round-trips through a JSON envelope", async () => {
    const write = await server.callTool("write_file", { path: "notes/a.txt", content: "hello" });
    expect(write.isError).toBeFalsy();
    expect(JSON.parse(write.content)).toMatchObject({
      path: path.join("notes", "a.txt"),
      created: true,
    });

    // It actually hit disk under the sandbox root.
    const onDisk = await fs.readFile(path.join(root, "notes", "a.txt"), "utf8");
    expect(onDisk).toBe("hello");

    const read = await server.callTool("read_file", { path: "notes/a.txt" });
    expect(read.isError).toBeFalsy();
    expect(JSON.parse(read.content).content).toBe("hello");
  });

  test("confines IO to the sandbox root (absolute escape is refused as a tool error)", async () => {
    const outside = path.join(os.tmpdir(), "escapee.txt");

    const result = await server.callTool("write_file", { path: outside, content: "nope" });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Workspace violation");
    await expect(fs.access(outside)).rejects.toThrow();
  });

  test("an unknown tool name returns an error result, not a throw", async () => {
    const result = await server.callTool("nonexistent", {});
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Unknown tool");
  });
});
