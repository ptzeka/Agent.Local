import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createFsMcpServer } from "../../src/agent/synthetic-mcp/fs-server.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

/**
 * The in-process fsmcp server that replaced the spawned stdio server. It is a
 * real MCP Server linked to a Client over an in-memory transport, so the tests
 * drive it exactly the way McpClient does: list_tools + call_tool over the
 * Client. IO must stay confined to the injected sandbox root.
 */

/** Pull the text payload out of an MCP call_tool result. */
function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const blocks = result.content as Array<{ type: string; text?: string }>;
  return blocks
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n");
}

describe("createFsMcpServer", () => {
  let root: string;
  let client: Client;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "fs-server-"));
    ({ client } = await createFsMcpServer(root));
  });

  afterEach(async () => {
    await client.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  test("advertises the seven fs tools under the fsmcp server", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "delete_file",
      "edit_file",
      "glob",
      "grep",
      "list_dir",
      "read_file",
      "write_file",
    ]);
    // inputSchema is real JSON Schema derived from the Zod schema.
    const readFile = tools.find((t) => t.name === "read_file");
    expect(readFile?.inputSchema).toMatchObject({ type: "object" });
  });

  test("write_file then read_file round-trips through a JSON envelope", async () => {
    const write = await client.callTool({
      name: "write_file",
      arguments: { path: "notes/a.txt", content: "hello" },
    });
    expect(write.isError).toBeFalsy();
    expect(JSON.parse(textOf(write))).toMatchObject({
      path: path.join("notes", "a.txt"),
      created: true,
    });

    // It actually hit disk under the sandbox root.
    const onDisk = await fs.readFile(path.join(root, "notes", "a.txt"), "utf8");
    expect(onDisk).toBe("hello");

    const read = await client.callTool({
      name: "read_file",
      arguments: { path: "notes/a.txt" },
    });
    expect(read.isError).toBeFalsy();
    expect(JSON.parse(textOf(read)).content).toBe("hello");
  });

  test("confines IO to the sandbox root (absolute escape is refused as a tool error)", async () => {
    const outside = path.join(os.tmpdir(), "escapee.txt");

    const result = await client.callTool({
      name: "write_file",
      arguments: { path: outside, content: "nope" },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Workspace violation");
    await expect(fs.access(outside)).rejects.toThrow();
  });

  test("an unknown tool name returns an error result, not a throw", async () => {
    const result = await client.callTool({ name: "nonexistent", arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Unknown tool");
  });
});
