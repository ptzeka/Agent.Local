import type { ToolExecutionResult } from "./mcp.js";
import type { ToolOutputSchema } from "./tooldescriptor.js";

// ---------------------------------------------------------------------------
// Response contract
// ---------------------------------------------------------------------------

// the ONE place a declared `outputSchema` is enforced. Lives at the client layer, not in any tool body,
// so an in-process server and a spawned stdio one are held to the same contract by the same code.

// normalises a tool's answer to the declared shape, then fails it on any violation. a conforming result
// is REWRITTEN to the parsed record, so callers downstream always see the declared JSON, never prose
export function enforceOutputContract(
  result: ToolExecutionResult,
  schema: ToolOutputSchema | undefined
): ToolExecutionResult {
  if (!schema) return result;
  // an already-failed call carries the server's own error wording; re-shaping it would bury the cause
  if (result.isError) return result;

  const record = parseOutput(result.content, schema);
  const violations = validateOutput(record, schema);
  return {
    ...result,
    isError: violations.length > 0,
    content: violations.length > 0
      ? `[contract-violation] ${violations.join("; ")}\n${JSON.stringify(record)}`
      : JSON.stringify(record),
  };
}

// parses the answer into a record keyed by the declared shape. a tolerant extract (first '{' through
// last '}') tolerates prose/```json fences around the object. per-field `default`s fill on parse failure
// or an empty field, so a flaky server yields the declared safe default instead of trapping the caller
export function parseOutput(raw: string, schema?: ToolOutputSchema): Record<string, unknown> {
  const base = defaultsOf(schema);
  const json = extractJsonObject(raw);
  if (json === null) return base;
  try {
    return { ...base, ...stripEmpty(JSON.parse(json) as Record<string, unknown>) };
  } catch {
    return base;
  }
}

// required present + non-empty, and any enum-constrained field within its set. Returns human-readable
// violations (empty = valid) so the caller can name the offending field back to the model
export function validateOutput(value: Record<string, unknown>, schema: ToolOutputSchema): string[] {
  const violations: string[] = [];
  for (const field of schema.required ?? []) {
    const v = value[field];
    if (v === undefined || v === null || v === "") violations.push(`missing required "${field}"`);
  }
  for (const [field, spec] of Object.entries(schema.properties ?? {})) {
    const allowed = (spec as { enum?: unknown[] }).enum;
    if (allowed && value[field] !== undefined && !allowed.includes(value[field])) {
      violations.push(`"${field}" must be one of ${allowed.join(", ")}`);
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

// a present-but-empty field must not shadow its default (the server emitted the key with no value)
function stripEmpty(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined && value !== null && value !== "") out[key] = value;
  }
  return out;
}

function defaultsOf(schema?: ToolOutputSchema): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [field, spec] of Object.entries(schema?.properties ?? {})) {
    const value = (spec as { default?: unknown }).default;
    if (value !== undefined) out[field] = value;
  }
  return out;
}

function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  return text.slice(start, end + 1);
}
