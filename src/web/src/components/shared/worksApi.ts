// typed fetch helpers over the host's user-scoped work API (/api/works). Plain fetch like useHealth/UserMenu —
// the session cookie rides same-origin, so the host scopes every call to the logged-in user. No axios/OpenAPI
// gen yet; the full M8-2 typed-client machinery stays deferred.

// mirrors the host's JobRecord (src/host/src/jobs/job-registry.ts); the wire shape the work table renders.
export interface WorkRecord {
  jobId: string;
  userId: string;
  workflowId: string | null;
  status: "new" | "running" | "stuck" | "stopped" | "cancelled" | "done" | "complete";
  step: string | null;
  sessionId: string | null;
  temporalId: string | null;
  statusDescription: string | null;
  ts: string;
}

// mirrors the host's StatusCode (src/host/src/jobs/job-status.ts) — the status catalog the UI renders from.
// `tone` is presentation-neutral (the page maps it to a chip color); the flags drive the per-row action gating.
export interface StatusCode {
  status: string;
  label: string;
  tone: "neutral" | "active" | "warn" | "error" | "success";
  terminal: boolean;
  stoppable: boolean;
  continuable: boolean;
}

// mirrors the host's WorkflowTemplate (src/temporal/src/workflows/index.ts) — one startable workflow the
// console offers in its Start dropdown. `name` is the Temporal Workflow Type passed back to createWork.
export interface WorkflowTemplate {
  name: string;
  label: string;
}

async function asJson<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.url} -> ${res.status}`);
  return (await res.json()) as T;
}

// the startable workflow catalog from the host (sourced from code, not hardcoded), so the Start dropdown reflects
// exactly what the worker can run. Fetched once on page load.
export async function getWorkflows(): Promise<WorkflowTemplate[]> {
  const { workflows } = await asJson<{ workflows: WorkflowTemplate[] }>(await fetch("/api/works/workflows"));
  return workflows;
}

// the status catalog (labels, tone, action flags) from the host lookup table; fetched once so the table renders
// status presentation and gates row actions from data rather than hardcoded conditionals
export async function getStatusCodes(): Promise<StatusCode[]> {
  const { statusCodes } = await asJson<{ statusCodes: StatusCode[] }>(await fetch("/api/works/statuscodes"));
  return statusCodes;
}

// search the caller's works, newest-first; optional status filter (e.g. "running")
export async function searchWorks(status?: string): Promise<WorkRecord[]> {
  const qs = status ? `?status=${encodeURIComponent(status)}` : "";
  const { works } = await asJson<{ works: WorkRecord[] }>(await fetch(`/api/works${qs}`));
  return works;
}

// current state of one work the caller owns; throws on 404 (not found / not yours)
export async function getWork(workId: string): Promise<WorkRecord> {
  const { work } = await asJson<{ work: WorkRecord }>(await fetch(`/api/works/${encodeURIComponent(workId)}`));
  return work;
}

// create (start) a work by workflow type; returns the new workId the caller queries by
export async function createWork(workflowId: string): Promise<string> {
  const { workId } = await asJson<{ workId: string }>(
    await fetch("/api/works", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflowId }),
    }),
  );
  return workId;
}

// stop a work the caller owns; returns its updated record (status "stopped")
export async function stopWork(workId: string, reason?: string): Promise<WorkRecord> {
  const { work } = await asJson<{ work: WorkRecord }>(
    await fetch(`/api/works/${encodeURIComponent(workId)}/stop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason }),
    }),
  );
  return work;
}

// continue (re-execute the stuck step of) a work the caller owns; returns its updated record (status "running").
// only a `stuck` work is resettable — the host answers 409 otherwise, which asJson surfaces as a thrown error.
export async function continueWork(workId: string): Promise<WorkRecord> {
  const { work } = await asJson<{ work: WorkRecord }>(
    await fetch(`/api/works/${encodeURIComponent(workId)}/continue`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
  );
  return work;
}
