// typed fetch helpers over the host's user-scoped work API (/api/works). Plain fetch like useHealth/UserMenu —
// the session cookie rides same-origin, so the host scopes every call to the logged-in user. No axios/OpenAPI
// gen yet; the full M8-2 typed-client machinery stays deferred.

// mirrors the host's JobRecord (src/host/src/jobs/job-registry.ts); the wire shape the work table renders.
export interface WorkRecord {
  jobId: string;
  userId: string;
  workflowId: string | null;
  status: "new" | "running" | "stuck" | "cancelled" | "stopped" | "error" | "completed";
  step: string | null;
  sessionId: string | null;
  camundaId: string | null;
  reason: string | null;
  ts: string;
}

async function asJson<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.url} -> ${res.status}`);
  return (await res.json()) as T;
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

// create (start) a work by bpmn workflowId; returns the new workId the caller queries by
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
