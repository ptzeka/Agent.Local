import type { AgentRuntimeQueryable } from "../../runtime/types.js";
import type { RoleReturnsSchema } from "../../registries/configuration-registry.js";

// ---------------------------------------------------------------------------
// Dispatch-result boundary
// ---------------------------------------------------------------------------

// the ONE place a dispatched sub-agent's answer becomes a structured record + a conversation line.
// role-agnostic: shape, defaults, and the stamp template all come from the role's `returns` config, so
// a new dispatchable role adds a config record, never a branch here. JSON is the return contract.

// parses the child's answer into a record keyed by the declared shape. a tolerant extract (first '{'
// through last '}') tolerates prose/```json fences around the object. per-field `default`s fill on parse
// failure or an empty field, so a flaky agent yields the declared safe default instead of trapping the caller
export function parseDispatchResult(raw: string, returns?: RoleReturnsSchema): Record<string, unknown> {
  const base = defaultsOf(returns);
  const json = extractJsonObject(raw);
  if (json === null) return base;
  try {
    return { ...base, ...stripEmpty(JSON.parse(json) as Record<string, unknown>) };
  } catch {
    return base;
  }
}

// required present + non-empty, and any enum-constrained field within its set. Returns human-readable
// violations (empty = valid) — the single check the dispatch boundary runs after a sub-agent responds
export function validateShape(value: Record<string, unknown>, schema: RoleReturnsSchema): string[] {
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

// fills a role's `report` template: {field} → record value, {field:upper} → upper-cased. display only,
// so the record itself keeps its declared form (e.g. lower-case enum) for downstream consumers
export function renderReport(template: string, record: Record<string, unknown>): string {
  return template.replace(/\{(\w+)(?::(\w+))?\}/g, (_match, field: string, modifier?: string) => {
    const value = String(record[field] ?? "");
    return modifier === "upper" ? value.toUpperCase() : value;
  });
}

// stamps a dispatched role's validated record into the PARENT conversation using the role's `report`
// template, so the verdict survives into later turns. Parse + shape-gate happen inside the dispatch tool
// (the MCP call is the contract boundary); this is only the caller-side reporting of the returned record
export async function stampReport(
  runtime: AgentRuntimeQueryable,
  role: string,
  record: Record<string, unknown>
): Promise<void> {
  const report = runtime.getModelsRegistry().getRoleDefinition(role).dispatch?.returns?.report;
  if (!report) return;
  const conversation = runtime.getConversation();
  conversation.append({ role: "system", content: renderReport(report, record) });
  await conversation.flush();
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

// a present-but-empty field must not shadow its default (the agent emitted the key with no value)
function stripEmpty(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined && value !== null && value !== "") out[key] = value;
  }
  return out;
}

function defaultsOf(returns?: RoleReturnsSchema): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [field, spec] of Object.entries(returns?.properties ?? {})) {
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
