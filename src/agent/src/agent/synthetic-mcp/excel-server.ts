// unlike fsmcp's static root, Excel tools need per-turn context, so this bakes the turn's ToolContext into each handler
// like fsmcp, exposed as a LocalMcp: a tool call is a plain in-process function call, no JSON-RPC

import { LocalMcp, type LocalTool } from "../mcp/local-mcp.js";
import {
  createExcelTools,
  GET_EXCEL_COLUMNS_TOOL,
  LIST_EXCEL_SHEETS_TOOL,
  QUERY_EXCEL_ROWS_TOOL,
  READ_EXCEL_SHEET_TOOL,
} from "./excel-tools/excel-tools.js";
import type { SyntheticMcp, ToolContext } from "./types.js";

export const EXCEL_SERVER_NAME = "excel";

export const EXCEL_READONLY_SERVER_NAME = "excelreadonly";

// ALLOWLIST, not a denylist: a mutating tool added later stays out unless listed here
const READ_ONLY_EXCEL_TOOL_NAMES = new Set([
  LIST_EXCEL_SHEETS_TOOL,
  GET_EXCEL_COLUMNS_TOOL,
  READ_EXCEL_SHEET_TOOL,
  QUERY_EXCEL_ROWS_TOOL,
]);

// binds the turn's ToolContext into each tool's invoke so the server matches the Mcp contract
export function createExcelLocalMcp(toolCtx: ToolContext): LocalMcp {
  return new LocalMcp(EXCEL_SERVER_NAME, bindToolContext(createExcelTools(), toolCtx));
}

// same enforcement as createFsReadonlyLocalMcp: append/insert/delete aren't mounted, not merely discouraged
export function createExcelReadonlyLocalMcp(toolCtx: ToolContext): LocalMcp {
  const readOnlyTools = createExcelTools().filter((tool) => READ_ONLY_EXCEL_TOOL_NAMES.has(tool.name));
  return new LocalMcp(EXCEL_READONLY_SERVER_NAME, bindToolContext(readOnlyTools, toolCtx));
}

function bindToolContext(tools: SyntheticMcp[], toolCtx: ToolContext): LocalTool[] {
  return tools.map((tool) => ({
    descriptor: tool.descriptor,
    invoke: async (args) => {
      const result = await tool.callTool(args ?? {}, toolCtx);
      return { isError: result.isError, content: result.content };
    },
  }));
}
