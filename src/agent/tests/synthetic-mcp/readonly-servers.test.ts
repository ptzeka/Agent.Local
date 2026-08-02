import { describe, expect, test } from "@jest/globals";

import { createFsReadonlyLocalMcp } from "../../src/agent/synthetic-mcp/fs-server.js";
import { createExcelReadonlyLocalMcp } from "../../src/agent/synthetic-mcp/excel-server.js";
import type { ToolContext } from "../../src/agent/synthetic-mcp/types.js";

// Read-only mounts — the enforced half of the orchestrator/executor split. The contract under test is the
// boundary: mutating tools must be absent from the advertisement AND uncallable, so a coordinator granted
// only these mounts cannot mutate no matter what it emits.

const MUTATING_FS_TAILS = ["write_file", "edit_file", "delete_file"];
const MUTATING_EXCEL_TAILS = ["append_excel_rows", "append_after_excel_rows", "delete_excel_rows"];

// tool handlers are never invoked in these tests; only mounting is exercised
const fakeToolContext = {
  session: {},
  workspace: {},
  sandboxRoot: "/tmp/sandbox",
  signal: undefined,
} as unknown as ToolContext;

describe("read-only server mounts", () => {
  test("fsreadonly advertises exactly the inspection tools, namespaced", () => {
    const server = createFsReadonlyLocalMcp("/tmp/sandbox");
    const names = server.listTools().map((tool) => tool.name).sort();

    expect(names).toEqual([
      "fsreadonly__glob",
      "fsreadonly__grep",
      "fsreadonly__list_dir",
      "fsreadonly__read_file",
    ]);
  });

  test("fsreadonly refuses mutating tool calls outright", async () => {
    const server = createFsReadonlyLocalMcp("/tmp/sandbox");

    for (const tail of MUTATING_FS_TAILS) {
      const result = await server.callTool(tail, { path: "x.txt", content: "x" });
      expect(result.isError).toBe(true);
      expect(result.content).toContain(`Unknown tool "${tail}"`);
    }
  });

  test("excelreadonly advertises exactly the inspection tools, namespaced", () => {
    const server = createExcelReadonlyLocalMcp(fakeToolContext);
    const names = server.listTools().map((tool) => tool.name).sort();

    expect(names).toEqual([
      "excelreadonly__get_excel_columns",
      "excelreadonly__list_sheets",
      "excelreadonly__query_excel_rows",
      "excelreadonly__read_excel_sheet",
    ]);
  });

  test("excelreadonly refuses mutating tool calls outright", async () => {
    const server = createExcelReadonlyLocalMcp(fakeToolContext);

    for (const tail of MUTATING_EXCEL_TAILS) {
      const result = await server.callTool(tail, { file_path: "x.xlsx", rows: [] });
      expect(result.isError).toBe(true);
      expect(result.content).toContain(`Unknown tool "${tail}"`);
    }
  });
});
