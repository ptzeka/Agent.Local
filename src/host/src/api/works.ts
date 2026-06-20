import { Router, type Request, type Response } from "express";
import type { ILogger } from "@agent-local/common";
import type { DatabaseHandle } from "@agent-local/common/db";
import type { WorkflowTemplate } from "@agent-local/temporal";
import { requirePermission } from "../user/userContext.js";
import type { JobRegistry, JobStatus } from "../jobs/job-registry.js";
import { readStatusCodes } from "../jobs/db-schema.js";
import type { Orchestrator } from "../orchestrator.js";

// the user-scoped work API: the host BFF resource over the work-unit registry. Every route is gated AND scoped
// to the caller's identity (req.userContext.userInfo.sub, set by userContextMiddleware) so a user only ever
// sees or stops their OWN works. "save" is just create for now (edit deferred); create runs the trigger flow.
export function createWorksApi(
  orchestrator: Orchestrator,
  jobs: JobRegistry,
  db: DatabaseHandle,
  workflows: WorkflowTemplate[],
  logger: ILogger,
): Router {
  const router = Router();

  // the owner of THIS request; requirePermission guarantees userInfo is non-null before these handlers run
  const owner = (req: Request): string => req.userContext.userInfo!.sub;

  // workflow catalog: the startable workflow templates (name + label), sourced from code (@agent-local/temporal's
  // WORKFLOW_TEMPLATES) so the console's workflow dropdown reflects what the worker can actually run rather than a
  // hardcoded string. Static reference data, owner-agnostic. MUST precede "/api/works/:workId" or the param route
  // would capture "workflows" as a workId. An empty array means no workflow is registered — the UI then has nothing
  // to start, which is the truthful state.
  router.get("/api/works/workflows", requirePermission("workflow:read"), (_req: Request, res: Response) => {
    if (workflows.length === 0) logger.warn?.("[host] workflow catalog is empty — the console will offer no workflow to start");
    res.json({ workflows });
  });

  // status catalog: the work-unit status codes (label + presentation tone + action flags) read from the DB
  // lookup table, so the UI renders colors and gates Stop/Continue/Refresh from data instead of hardcoding them.
  // Static reference data, owner-agnostic — gated read-only like the rest of the surface. MUST precede
  // "/api/works/:workId" or that param route would capture "statuscodes" as a workId.
  router.get("/api/works/statuscodes", requirePermission("workflow:read"), (_req: Request, res: Response) => {
    res.json({ statusCodes: readStatusCodes(db) });
  });

  // search: the caller's works, optionally narrowed by ?status=. newest-first (registry sorts).
  router.get("/api/works", requirePermission("workflow:read"), async (req: Request, res: Response) => {
    const status = typeof req.query.status === "string" ? (req.query.status as JobStatus) : undefined;
    const works = await jobs.search({ userId: owner(req), status });
    // poll-time reconcile: kick a bus-pure describe for each unsettled work so a NEXT poll reflects engine truth.
    // `stopped` is included — it is a pending stop, so reconcile heals it to `cancelled` once the engine confirms.
    for (const work of works) {
      if (work.status === "new" || work.status === "running" || work.status === "stopped") {
        orchestrator.requestReconcile(work.jobId);
      }
    }
    res.json({ works });
  });

  // get: one work's current state by workId; 404 unless it exists AND belongs to the caller (no leak of ids)
  router.get("/api/works/:workId", requirePermission("workflow:read"), async (req: Request, res: Response) => {
    const work = await jobs.get(req.params.workId);
    if (!work || work.userId !== owner(req)) {
      res.status(404).json({ error: "unknown work" });
      return;
    }
    // poll-time reconcile: an unsettled work asks the engine for its live state; this read returns the current
    // record, the fold lands async (bus-pure) so the next read shows it — orphaned workflows surface as stuck, a
    // pending `stopped` settles to `cancelled` once the engine confirms the cancel (the Refresh recovery path).
    if (work.status === "new" || work.status === "running" || work.status === "stopped") {
      orchestrator.requestReconcile(work.jobId);
    }
    res.json({ work });
  });

  // create: spin up a work owned by the caller (camunda instance -> agent session -> first step). 202 + workId.
  router.post("/api/works", requirePermission("workflow:write"), (req: Request, res: Response) => {
    const workflowId = String((req.body ?? {}).workflowId ?? "");
    orchestrator
      .trigger(workflowId, owner(req))
      .then((workId) => res.status(202).json({ workId }))
      .catch((err) => res.status(503).json({ error: String(err) }));
  });

  // stop: cancel the caller's work (camunda cancel + agent session close), record `stopped` with a reason.
  // 404 when the work isn't the caller's (orchestrator.stop returns null), so stop can't reach across owners.
  router.post("/api/works/:workId/stop", requirePermission("workflow:write"), async (req: Request, res: Response) => {
    const reason = String((req.body ?? {}).reason ?? "stopped by user");
    const work = await orchestrator.stop(req.params.workId, owner(req), reason);
    if (!work) {
      res.status(404).json({ error: "unknown work" });
      return;
    }
    logger.debug?.(`[host] stopped work ${work.jobId}: ${reason}`);
    res.json({ work });
  });

  // continue: re-execute a stuck step of the caller's work via engine Reset. 404 when not the caller's, 409 when
  // the work is not `stuck` (only a stuck work is resettable; a running one the engine refuses anyway).
  router.post("/api/works/:workId/continue", requirePermission("workflow:write"), async (req: Request, res: Response) => {
    const result = await orchestrator.continue(req.params.workId, owner(req));
    if (result === null) {
      res.status(404).json({ error: "unknown work" });
      return;
    }
    if (result === false) {
      res.status(409).json({ error: "work is not stuck" });
      return;
    }
    logger.debug?.(`[host] continued (reset) work ${result.jobId}`);
    res.status(202).json({ work: result });
  });

  // inject: operator intervention onto the caller's running work — merge variables onto its camunda instance.
  // 404 when not the caller's, 409 when the instance has not started yet. body: { variables, scopeKey?, local? }.
  router.post("/api/works/:workId/inject", requirePermission("workflow:write"), async (req: Request, res: Response) => {
    const body = req.body ?? {};
    const variables = (body.variables ?? {}) as Record<string, unknown>;
    const result = await orchestrator.inject(req.params.workId, owner(req), variables, {
      scopeKey: typeof body.scopeKey === "string" ? body.scopeKey : undefined,
      local: typeof body.local === "boolean" ? body.local : undefined,
    });
    if (result === null) {
      res.status(404).json({ error: "unknown work" });
      return;
    }
    if (result === false) {
      res.status(409).json({ error: "work has no running instance" });
      return;
    }
    res.status(202).json({ work: result });
  });

  // retry: re-activate a failed step of the caller's work by jobKey (from the failed-work detail). 404 when not
  // the caller's, 400 without a jobKey. body: { jobKey, incidentKey?, retries? }. inert until jobs actually fail.
  router.post("/api/works/:workId/retry", requirePermission("workflow:write"), async (req: Request, res: Response) => {
    const body = req.body ?? {};
    const jobKey = typeof body.jobKey === "string" ? body.jobKey : "";
    if (!jobKey) {
      res.status(400).json({ error: "jobKey required" });
      return;
    }
    const work = await orchestrator.retryStep(req.params.workId, owner(req), jobKey, {
      incidentKey: typeof body.incidentKey === "string" ? body.incidentKey : undefined,
      retries: typeof body.retries === "number" ? body.retries : undefined,
    });
    if (!work) {
      res.status(404).json({ error: "unknown work" });
      return;
    }
    res.status(202).json({ work });
  });

  return router;
}
