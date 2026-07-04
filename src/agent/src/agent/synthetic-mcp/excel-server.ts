// unlike fsmcp's static root, Excel tools need session/workspace context, baked in once at registration
// like fsmcp, exposed as a LocalMcp: a tool call is a plain in-process function call, no JSON-RPC

import { LocalMcp } from "@agent-local/mcp";
import {
  createExcelTools,
  GET_EXCEL_COLUMNS_TOOL,
  LIST_EXCEL_SHEETS_TOOL,
  QUERY_EXCEL_ROWS_TOOL,
  READ_EXCEL_SHEET_TOOL,
} from "./excel-tools/excel-tools.js";
import { bindToolContext, type ToolContext } from "./types.js";

export const EXCEL_SERVER_NAME = "excel";

export const EXCEL_READONLY_SERVER_NAME = "excelreadonly";

// ALLOWLIST, not a denylist: a mutating tool added later stays out unless listed here
const READ_ONLY_EXCEL_TOOL_NAMES = new Set([
  LIST_EXCEL_SHEETS_TOOL,
  GET_EXCEL_COLUMNS_TOOL,
  READ_EXCEL_SHEET_TOOL,
  QUERY_EXCEL_ROWS_TOOL,
]);

export function createExcelLocalMcp(toolCtx: ToolContext): LocalMcp {
  return new LocalMcp(EXCEL_SERVER_NAME, bindToolContext(createExcelTools(), toolCtx));
}

// same enforcement as createFsReadonlyLocalMcp: append/insert/delete aren't mounted, not merely discouraged
export function createExcelReadonlyLocalMcp(toolCtx: ToolContext): LocalMcp {
  const readOnlyTools = createExcelTools().filter((tool) => READ_ONLY_EXCEL_TOOL_NAMES.has(tool.name));
  return new LocalMcp(EXCEL_READONLY_SERVER_NAME, bindToolContext(readOnlyTools, toolCtx));
}
