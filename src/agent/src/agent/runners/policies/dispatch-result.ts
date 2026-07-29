import type { AgentRuntimeQueryable } from "../../runtime/types.js";

// ---------------------------------------------------------------------------
// Dispatch-result reporting
// ---------------------------------------------------------------------------

// parsing and shape-gating moved to `@agent-local/mcp/output-contract`, where the MCP client applies them
// to every server. What remains is the caller-side half the client has no use for: stamping the validated
// record back into the PARENT conversation using the role's `report` template.

// fills a role's `report` template: {field} → record value, {field:upper} → upper-cased. display only,
// so the record itself keeps its declared form (e.g. lower-case enum) for downstream consumers
export function renderReport(template: string, record: Record<string, unknown>): string {
  return template.replace(/\{(\w+)(?::(\w+))?\}/g, (_match, field: string, modifier?: string) => {
    const value = String(record[field] ?? "");
    return modifier === "upper" ? value.toUpperCase() : value;
  });
}

// stamps a dispatched role's validated record into the PARENT conversation using the role's `report`
// template, so the verdict survives into later turns. Parse + shape-gate already happened in the MCP
// client; this is only the caller-side reporting of the record it returned
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
