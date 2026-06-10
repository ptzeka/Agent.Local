import { promises as fs } from "node:fs";
import path from "node:path";

import * as XLSX from "xlsx";

import type { ToolExecutionResult } from "../../mcp-client.js";
import type { ToolDescriptor } from "../../providers/provider.js";
import { toolError, toolOk, type SyntheticMcp, type SyntheticMcpContext } from "../types.js";

export const READ_EXCEL_SHEET_TOOL = "read_excel_sheet";
export const GET_EXCEL_COLUMNS_TOOL = "get_excel_columns";
export const QUERY_EXCEL_ROWS_TOOL = "query_excel_rows";
export const LIST_EXCEL_SHEETS_TOOL = "list_sheets";
export const APPEND_EXCEL_ROWS_TOOL = "append_excel_rows";
export const APPEND_AFTER_EXCEL_ROWS_TOOL = "append_after_excel_rows";

/**
 * Excel synthetic tools — SheetJS-backed read/query/append over .xlsx files.
 *
 * Like the other synthetic tools these LOOK like real MCP tools to the LLM, but
 * the orchestrator intercepts them and runs them in-process. Unlike
 * dispatch_executor (which routes every mutation through the executor), these
 * are self-contained DATA operations: a spreadsheet read/append is a single,
 * well-bounded effect, so routing it through a free-form sub-agent would add
 * cost and non-determinism without buying safety.
 *
 * Every file_path is workspace-relative and resolved under
 * `{sandboxRoot}/{workspaceId}/` (see `resolveWorkspacePath`), the same segment
 * fsmcp and the executor write to — absolute paths and `..` escapes are refused
 * deterministically in agent code, never trusting the model to behave.
 */

/**
 * Build Excel tool descriptors for advertisement (without creating handlers).
 * Used to include Excel tools in the visible tools list at turn setup.
 */
export function getExcelToolDescriptors(): ToolDescriptor[] {
  return createExcelTools().map((tool) => ({
    name: tool.name,
    description: tool.descriptor.description,
    inputSchema: tool.descriptor.inputSchema,
  }));
}

export function createExcelTools(): SyntheticMcp[] {
  return [
    { name: LIST_EXCEL_SHEETS_TOOL, descriptor: listSheetsDescriptor(), callTool: handleListSheets },
    { name: GET_EXCEL_COLUMNS_TOOL, descriptor: getColumnsDescriptor(), callTool: handleGetColumns },
    { name: READ_EXCEL_SHEET_TOOL, descriptor: readSheetDescriptor(), callTool: handleReadSheet },
    { name: QUERY_EXCEL_ROWS_TOOL, descriptor: queryRowsDescriptor(), callTool: handleQueryRows },
    { name: APPEND_EXCEL_ROWS_TOOL, descriptor: appendRowsDescriptor(), callTool: handleAppendRows },
    {
      name: APPEND_AFTER_EXCEL_ROWS_TOOL,
      descriptor: appendAfterRowsDescriptor(),
      callTool: handleAppendAfterRows,
    },
  ];
}

// ---------------------------------------------------------------------------
// Row model
// ---------------------------------------------------------------------------

/** A spreadsheet row as a header-keyed object — the shape used in and out. */
type Row = Record<string, unknown>;

/** A single AND-ed filter clause for query_excel_rows. */
type FilterOp = "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "contains";
interface FilterCondition {
  column: string;
  op: FilterOp;
  value: unknown;
}

const FILTER_OPS: readonly FilterOp[] = ["eq", "ne", "gt", "gte", "lt", "lte", "contains"];

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleListSheets(
  args: Record<string, unknown>,
  ctx: SyntheticMcpContext
): Promise<ToolExecutionResult> {
  const filePath = requireString(args.file_path, "file_path");
  if (!filePath.ok) return toolError(`[excel-error] ${filePath.reason}`);

  const loaded = await loadWorkbook(ctx, filePath.value);
  if (!loaded.ok) return toolError(`[excel-error] ${loaded.reason}`);

  return toolOk(JSON.stringify({ file_path: filePath.value, sheets: loaded.value.SheetNames }, null, 2));
}

async function handleGetColumns(
  args: Record<string, unknown>,
  ctx: SyntheticMcpContext
): Promise<ToolExecutionResult> {
  const filePath = requireString(args.file_path, "file_path");
  if (!filePath.ok) return toolError(`[excel-error] ${filePath.reason}`);

  const loaded = await loadWorkbook(ctx, filePath.value);
  if (!loaded.ok) return toolError(`[excel-error] ${loaded.reason}`);

  // sheet_name is optional here — default to the first sheet.
  const sheet = resolveSheet(loaded.value, optionalString(args.sheet_name));
  if (!sheet.ok) return toolError(`[excel-error] ${sheet.reason}`);

  const { headers } = sheetToTable(sheet.value.worksheet);
  return toolOk(
    JSON.stringify({ file_path: filePath.value, sheet_name: sheet.value.name, columns: headers }, null, 2)
  );
}

async function handleReadSheet(
  args: Record<string, unknown>,
  ctx: SyntheticMcpContext
): Promise<ToolExecutionResult> {
  const filePath = requireString(args.file_path, "file_path");
  if (!filePath.ok) return toolError(`[excel-error] ${filePath.reason}`);
  const sheetName = requireString(args.sheet_name, "sheet_name");
  if (!sheetName.ok) return toolError(`[excel-error] ${sheetName.reason}`);

  const loaded = await loadWorkbook(ctx, filePath.value);
  if (!loaded.ok) return toolError(`[excel-error] ${loaded.reason}`);

  const sheet = resolveSheet(loaded.value, sheetName.value);
  if (!sheet.ok) return toolError(`[excel-error] ${sheet.reason}`);

  const { headers, rows } = sheetToTable(sheet.value.worksheet);
  return toolOk(
    JSON.stringify(
      { file_path: filePath.value, sheet_name: sheet.value.name, columns: headers, row_count: rows.length, rows },
      null,
      2
    )
  );
}

async function handleQueryRows(
  args: Record<string, unknown>,
  ctx: SyntheticMcpContext
): Promise<ToolExecutionResult> {
  const filePath = requireString(args.file_path, "file_path");
  if (!filePath.ok) return toolError(`[excel-error] ${filePath.reason}`);

  const conditions = parseFilterConditions(args.filter_conditions);
  if (!conditions.ok) return toolError(`[excel-error] ${conditions.reason}`);

  const loaded = await loadWorkbook(ctx, filePath.value);
  if (!loaded.ok) return toolError(`[excel-error] ${loaded.reason}`);

  const sheet = resolveSheet(loaded.value, optionalString(args.sheet_name));
  if (!sheet.ok) return toolError(`[excel-error] ${sheet.reason}`);

  const { headers, rows } = sheetToTable(sheet.value.worksheet);
  const matched = rows.filter((row) => conditions.value.every((c) => matchesCondition(row, c)));

  return toolOk(
    JSON.stringify(
      {
        file_path: filePath.value,
        sheet_name: sheet.value.name,
        columns: headers,
        matched_count: matched.length,
        total_count: rows.length,
        rows: matched,
      },
      null,
      2
    )
  );
}

async function handleAppendRows(
  args: Record<string, unknown>,
  ctx: SyntheticMcpContext
): Promise<ToolExecutionResult> {
  const parsed = parseAppendArgs(args);
  if (!parsed.ok) return toolError(`[excel-error] ${parsed.reason}`);

  // null insertAt => append at the very end (see writeRows).
  return writeRows(ctx, parsed.value.filePath, parsed.value.sheetName, parsed.value.rows, null);
}

async function handleAppendAfterRows(
  args: Record<string, unknown>,
  ctx: SyntheticMcpContext
): Promise<ToolExecutionResult> {
  const parsed = parseAppendArgs(args);
  if (!parsed.ok) return toolError(`[excel-error] ${parsed.reason}`);

  const afterRow = args.after_row;
  if (typeof afterRow !== "number" || !Number.isInteger(afterRow) || afterRow < 0) {
    return toolError(
      `[excel-error] ${APPEND_AFTER_EXCEL_ROWS_TOOL}.after_row must be a non-negative integer ` +
        `(0 = insert right after the header, N = insert after the Nth data row)`
    );
  }

  return writeRows(ctx, parsed.value.filePath, parsed.value.sheetName, parsed.value.rows, afterRow);
}

// ---------------------------------------------------------------------------
// Write path (shared by both append tools)
// ---------------------------------------------------------------------------

/**
 * Insert `newRows` into a sheet and persist the workbook. `insertAt` is the
 * 0-based data-row index to splice in front of; `null` means append at the end.
 * Creates the file/sheet when missing, and widens the header union so rows that
 * introduce a new column don't silently lose data.
 */
async function writeRows(
  ctx: SyntheticMcpContext,
  filePath: string,
  sheetName: string,
  newRows: Row[],
  insertAt: number | null
): Promise<ToolExecutionResult> {
  const resolved = resolveWorkspacePath(ctx, filePath);
  if (!resolved.ok) return toolError(`[excel-error] ${resolved.reason}`);

  // Load the existing workbook if present; otherwise start a fresh one. A read
  // error other than "file missing" is fatal — we must not clobber a file we
  // failed to parse.
  let workbook: XLSX.WorkBook;
  let existingRows: Row[] = [];
  let existingHeaders: string[] = [];
  const fileExists = await pathExists(resolved.absolutePath);
  if (fileExists) {
    const loaded = await loadWorkbook(ctx, filePath);
    if (!loaded.ok) return toolError(`[excel-error] ${loaded.reason}`);
    workbook = loaded.value;
    const sheet = workbook.Sheets[sheetName];
    if (sheet) {
      const table = sheetToTable(sheet);
      existingRows = table.rows;
      existingHeaders = table.headers;
    }
  } else {
    workbook = XLSX.utils.book_new();
  }

  if (insertAt !== null && insertAt > existingRows.length) {
    return toolError(
      `[excel-error] after_row ${insertAt} is past the last data row (${existingRows.length}) of ` +
        `sheet "${sheetName}"`
    );
  }

  // Combine, preserving column order: existing headers first, then any new keys
  // the appended rows introduce.
  const headers = unionHeaders(existingHeaders, newRows);
  const combined =
    insertAt === null
      ? [...existingRows, ...newRows]
      : [...existingRows.slice(0, insertAt), ...newRows, ...existingRows.slice(insertAt)];

  const worksheet = XLSX.utils.json_to_sheet(combined, { header: headers });
  if (workbook.Sheets[sheetName]) {
    workbook.Sheets[sheetName] = worksheet;
  } else {
    XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
  }

  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
  await fs.mkdir(path.dirname(resolved.absolutePath), { recursive: true });
  await fs.writeFile(resolved.absolutePath, buffer);

  ctx.emit({
    type: "tool-result",
    data: {
      tool: insertAt === null ? APPEND_EXCEL_ROWS_TOOL : APPEND_AFTER_EXCEL_ROWS_TOOL,
      file_path: filePath,
      sheet_name: sheetName,
      appended: newRows.length,
    },
  });

  return toolOk(
    JSON.stringify(
      {
        file_path: filePath,
        sheet_name: sheetName,
        created: !fileExists,
        appended_count: newRows.length,
        total_count: combined.length,
        columns: headers,
      },
      null,
      2
    )
  );
}

// ---------------------------------------------------------------------------
// Workbook / sheet helpers
// ---------------------------------------------------------------------------

/**
 * Read and parse a workbook from a workspace-relative path. Read uses a buffer
 * (XLSX.read) rather than XLSX.readFile so the path clamp stays in our code and
 * we never hand a raw path to SheetJS.
 */
async function loadWorkbook(
  ctx: SyntheticMcpContext,
  filePath: string
): Promise<{ ok: true; value: XLSX.WorkBook } | { ok: false; reason: string }> {
  const resolved = resolveWorkspacePath(ctx, filePath);
  if (!resolved.ok) return resolved;

  let buffer: Buffer;
  try {
    buffer = await fs.readFile(resolved.absolutePath);
  } catch (err) {
    if (isNotFound(err)) return { ok: false, reason: `file "${filePath}" not found in workspace` };
    return { ok: false, reason: `could not read "${filePath}": ${errorMessage(err)}` };
  }

  try {
    return { ok: true, value: XLSX.read(buffer, { type: "buffer" }) };
  } catch (err) {
    return { ok: false, reason: `could not parse "${filePath}" as a spreadsheet: ${errorMessage(err)}` };
  }
}

/** Resolve a sheet by name, or the first sheet when name is omitted. */
function resolveSheet(
  workbook: XLSX.WorkBook,
  sheetName: string | undefined
): { ok: true; value: { name: string; worksheet: XLSX.WorkSheet } } | { ok: false; reason: string } {
  if (workbook.SheetNames.length === 0) {
    return { ok: false, reason: "workbook contains no sheets" };
  }
  const name = sheetName ?? workbook.SheetNames[0];
  const worksheet = workbook.Sheets[name];
  if (!worksheet) {
    return {
      ok: false,
      reason: `sheet "${name}" not found; available sheets: ${workbook.SheetNames.join(", ")}`,
    };
  }
  return { ok: true, value: { name, worksheet } };
}

/**
 * Project a worksheet into a header list plus header-keyed rows. Reads the AoA
 * first so the header ORDER reflects the file's columns (sheet_to_json's object
 * keys alone would not preserve a stable order across rows).
 */
function sheetToTable(worksheet: XLSX.WorkSheet): { headers: string[]; rows: Row[] } {
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(worksheet, { header: 1, blankrows: false });
  const headerRow = matrix.length > 0 ? matrix[0] : [];
  const headers = headerRow.map((h) => String(h ?? ""));

  const rows: Row[] = [];
  for (let i = 1; i < matrix.length; i += 1) {
    const cells = matrix[i];
    const row: Row = {};
    headers.forEach((header, col) => {
      row[header] = col < cells.length ? cells[col] ?? null : null;
    });
    rows.push(row);
  }
  return { headers, rows };
}

/** Existing headers in order, plus any new keys the appended rows introduce. */
function unionHeaders(existingHeaders: string[], newRows: Row[]): string[] {
  const headers = existingHeaders.filter((h) => h.length > 0);
  const seen = new Set(headers);
  for (const row of newRows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        headers.push(key);
      }
    }
  }
  return headers;
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

/** Evaluate one AND-ed clause against a row. */
function matchesCondition(row: Row, condition: FilterCondition): boolean {
  const cell = row[condition.column];
  const target = condition.value;

  switch (condition.op) {
    case "eq":
      return looseEquals(cell, target);
    case "ne":
      return !looseEquals(cell, target);
    case "contains":
      return String(cell ?? "").includes(String(target ?? ""));
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      // Ordering only makes sense numerically; a non-numeric cell or target
      // never matches rather than producing a surprising string comparison.
      const a = Number(cell);
      const b = Number(target);
      if (Number.isNaN(a) || Number.isNaN(b)) return false;
      if (condition.op === "gt") return a > b;
      if (condition.op === "gte") return a >= b;
      if (condition.op === "lt") return a < b;
      return a <= b;
    }
    default:
      return false;
  }
}

/** Equality that bridges number/string cells (3 == "3"), else strict-ish. */
function looseEquals(cell: unknown, target: unknown): boolean {
  if (cell === target) return true;
  return String(cell ?? "") === String(target ?? "");
}

function parseFilterConditions(
  raw: unknown
): { ok: true; value: FilterCondition[] } | { ok: false; reason: string } {
  if (raw === undefined || raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) {
    return { ok: false, reason: "filter_conditions must be an array of {column, op, value}" };
  }

  const conditions: FilterCondition[] = [];
  for (const [index, entry] of raw.entries()) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return { ok: false, reason: `filter_conditions[${index}] must be an object` };
    }
    const { column, op, value } = entry as Record<string, unknown>;
    if (typeof column !== "string" || column.length === 0) {
      return { ok: false, reason: `filter_conditions[${index}].column must be a non-empty string` };
    }
    if (typeof op !== "string" || !FILTER_OPS.includes(op as FilterOp)) {
      return {
        ok: false,
        reason: `filter_conditions[${index}].op must be one of: ${FILTER_OPS.join(", ")}`,
      };
    }
    conditions.push({ column, op: op as FilterOp, value });
  }
  return { ok: true, value: conditions };
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseAppendArgs(
  args: Record<string, unknown>
): { ok: true; value: { filePath: string; sheetName: string; rows: Row[] } } | { ok: false; reason: string } {
  const filePath = requireString(args.file_path, "file_path");
  if (!filePath.ok) return { ok: false, reason: filePath.reason };
  const sheetName = requireString(args.sheet_name, "sheet_name");
  if (!sheetName.ok) return { ok: false, reason: sheetName.reason };

  if (!Array.isArray(args.rows)) {
    return { ok: false, reason: "rows must be an array of objects (each keyed by column name)" };
  }
  const rows: Row[] = [];
  for (const [index, entry] of args.rows.entries()) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return { ok: false, reason: `rows[${index}] must be an object keyed by column name` };
    }
    rows.push(entry as Row);
  }
  if (rows.length === 0) {
    return { ok: false, reason: "rows must contain at least one row to append" };
  }

  return { ok: true, value: { filePath: filePath.value, sheetName: sheetName.value, rows } };
}

function requireString(
  value: unknown,
  field: string
): { ok: true; value: string } | { ok: false; reason: string } {
  if (typeof value !== "string" || value.trim().length === 0) {
    return { ok: false, reason: `${field} must be a non-empty string` };
  }
  return { ok: true, value };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// ---------------------------------------------------------------------------
// Path clamp (mirrors ScopedToolClient: confine to {sandboxRoot}/{workspaceId})
// ---------------------------------------------------------------------------

function resolveWorkspacePath(
  ctx: SyntheticMcpContext,
  filePath: string
): { ok: true; absolutePath: string } | { ok: false; reason: string } {
  if (isAbsoluteLike(filePath)) {
    return { ok: false, reason: `path "${filePath}" must be workspace-relative (absolute paths are refused)` };
  }

  const segmentRoot = path.resolve(ctx.sandboxRoot, ctx.workspace.workspaceId);
  const resolved = path.resolve(segmentRoot, filePath);

  // Confirm the resolved path is still inside the workspace segment; a `..` that
  // climbs out lands elsewhere and is refused here.
  const relative = path.relative(segmentRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return { ok: false, reason: `path "${filePath}" escapes the workspace segment` };
  }
  return { ok: true, absolutePath: resolved };
}

/** Drive-letter, UNC, and rooted paths are treated as absolute and refused. */
function isAbsoluteLike(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || /^[\\/]/.test(value);
}

async function pathExists(absolutePath: string): Promise<boolean> {
  try {
    await fs.access(absolutePath);
    return true;
  } catch {
    return false;
  }
}

function isNotFound(err: unknown): boolean {
  return Boolean(err) && typeof err === "object" && (err as NodeJS.ErrnoException).code === "ENOENT";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Descriptors
// ---------------------------------------------------------------------------

function listSheetsDescriptor(): ToolDescriptor {
  return {
    name: LIST_EXCEL_SHEETS_TOOL,
    description: [
      "List the sheet (tab) names in an Excel workbook (.xlsx), in workbook",
      "order. Use this first to discover which sheets exist before reading or",
      "querying one. file_path is workspace-relative.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      required: ["file_path"],
      properties: {
        file_path: { type: "string", description: "Workspace-relative path to the .xlsx file." },
      },
    },
  };
}

function getColumnsDescriptor(): ToolDescriptor {
  return {
    name: GET_EXCEL_COLUMNS_TOOL,
    description: [
      "Return the column headers (first row) of a sheet, in order. If sheet_name",
      "is omitted, the first sheet is used. Use this to learn the column names",
      "before querying or appending rows.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      required: ["file_path"],
      properties: {
        file_path: { type: "string", description: "Workspace-relative path to the .xlsx file." },
        sheet_name: { type: "string", description: "Sheet to inspect; defaults to the first sheet." },
      },
    },
  };
}

function readSheetDescriptor(): ToolDescriptor {
  return {
    name: READ_EXCEL_SHEET_TOOL,
    description: [
      "Read an entire sheet as rows. Returns the column headers and every data",
      "row as an object keyed by column name (the header row itself is not",
      "included as a data row). For large sheets prefer query_excel_rows to",
      "filter server-side instead of reading everything.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      required: ["file_path", "sheet_name"],
      properties: {
        file_path: { type: "string", description: "Workspace-relative path to the .xlsx file." },
        sheet_name: { type: "string", description: "Name of the sheet to read." },
      },
    },
  };
}

function queryRowsDescriptor(): ToolDescriptor {
  return {
    name: QUERY_EXCEL_ROWS_TOOL,
    description: [
      "Return only the rows of a sheet that satisfy ALL of the given filter",
      "conditions (logical AND). Each condition is {column, op, value} where op",
      "is one of: eq, ne, gt, gte, lt, lte, contains. Ordering ops (gt/gte/lt/lte)",
      "compare numerically and skip non-numeric cells; eq/ne match by value",
      "(3 and \"3\" are equal); contains is a substring match. If sheet_name is",
      "omitted the first sheet is used. An empty/omitted filter returns all rows.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      required: ["file_path", "filter_conditions"],
      properties: {
        file_path: { type: "string", description: "Workspace-relative path to the .xlsx file." },
        sheet_name: { type: "string", description: "Sheet to query; defaults to the first sheet." },
        filter_conditions: {
          type: "array",
          description: "Conditions AND-ed together. Empty array matches every row.",
          items: {
            type: "object",
            required: ["column", "op", "value"],
            properties: {
              column: { type: "string", description: "Column header to test." },
              op: {
                type: "string",
                enum: [...FILTER_OPS],
                description: "Comparison operator.",
              },
              value: { description: "Value to compare the cell against." },
            },
          },
        },
      },
    },
  };
}

function appendRowsDescriptor(): ToolDescriptor {
  return {
    name: APPEND_EXCEL_ROWS_TOOL,
    description: [
      "Append rows to the END of a sheet. Each row is an object keyed by column",
      "name; keys are matched to existing headers, and any new key adds a new",
      "column. If the file or the named sheet does not exist yet it is created.",
      "file_path is workspace-relative.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      required: ["file_path", "sheet_name", "rows"],
      properties: {
        file_path: { type: "string", description: "Workspace-relative path to the .xlsx file." },
        sheet_name: { type: "string", description: "Sheet to append to (created if missing)." },
        rows: {
          type: "array",
          description: "Rows to append, each an object keyed by column name.",
          items: { type: "object" },
        },
      },
    },
  };
}

function appendAfterRowsDescriptor(): ToolDescriptor {
  return {
    name: APPEND_AFTER_EXCEL_ROWS_TOOL,
    description: [
      "Insert rows immediately AFTER a specific data row. after_row is 0-based on",
      "data rows (the header is not counted): 0 inserts right after the header",
      "(before the first data row), 1 inserts after the first data row, and so on.",
      "after_row must not exceed the current number of data rows. Otherwise behaves",
      "like append_excel_rows (header matching, new columns, file/sheet creation).",
    ].join("\n"),
    inputSchema: {
      type: "object",
      required: ["file_path", "sheet_name", "after_row", "rows"],
      properties: {
        file_path: { type: "string", description: "Workspace-relative path to the .xlsx file." },
        sheet_name: { type: "string", description: "Sheet to insert into (created if missing)." },
        after_row: {
          type: "integer",
          minimum: 0,
          description: "0-based data-row index to insert after (0 = right after the header).",
        },
        rows: {
          type: "array",
          description: "Rows to insert, each an object keyed by column name.",
          items: { type: "object" },
        },
      },
    },
  };
}
