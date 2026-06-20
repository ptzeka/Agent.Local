import { Router, type Request, type Response } from "express";
import type { ILogger } from "@agent-local/common";
import type { DatabaseHandle } from "@agent-local/common/db";
import type { WorkflowTemplate, WorkflowStep } from "@agent-local/temporal";
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
  // read-only Temporal seam: the work-detail GET folds in the engine's reconstructed step history. a function, not
  // the engine client, so the host still holds no engine handle (and degrades to no steps when Temporal is down).
  getSteps: (workId: string) => Promise<WorkflowStep[]>,
): Router {
  const router = Router();

  // the owner of THIS request; requirePermission guarantees userInfo is non-null before these handlers run
  const owner = (req: Request): string => req.userContext.userInfo!.sub;

  // a Temporal outage must not fail the work read — the record is host-owned truth, steps are a best-effort overlay.
  // the error is returned (not swallowed to []) so the UI can show WHY a started work shows no steps vs truly-empty.
  const safeSteps = async (workId: string): Promise<{ steps: WorkflowStep[]; error: string | null }> => {
    try {
      return { steps: await getSteps(workId), error: null };
    } catch (err) {
      logger.warn?.(`[host] step history for ${workId} unavailable: ${String(err)}`);
      return { steps: [], error: String(err) };
    }
  };

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
    // a `stopped` work is included only while its cleanup is pending (sessionId set), so reconcile closes the
    // released session — once cleaned it is fully settled and no longer pinged.
    for (const work of works) {
      if (work.status === "new" || work.status === "running" || (work.status === "stopped" && work.sessionId)) {
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
    // record, the fold lands async (bus-pure) so the next read shows it — orphaned/failed workflows surface as
    // `stopped`, and a stopped work with cleanup still pending (sessionId set) gets its released session closed.
    if (work.status === "new" || work.status === "running" || (work.status === "stopped" && work.sessionId)) {
      orchestrator.requestReconcile(work.jobId);
    }
    // step history: the engine's reconstructed per-step status, folded in so the detail view renders it from one
    // call. only once the work actually started (temporalId set) does the engine hold a history to read.
    const { steps, error: stepsError } = work.temporalId ? await safeSteps(work.jobId) : { steps: [], error: null };
    res.json({ work, steps, stepsError });
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

  // continue: pick a stopped work back up — re-execute its last step via engine Reset. 404 when not the caller's,
  // 409 when the work is not `stopped` (a clean completed work is done; a running one the engine refuses anyway).
  router.post("/api/works/:workId/continue", requirePermission("workflow:write"), async (req: Request, res: Response) => {
    const result = await orchestrator.continue(req.params.workId, owner(req));
    if (result === null) {
      res.status(404).json({ error: "unknown work" });
      return;
    }
    if (result === false) {
      res.status(409).json({ error: "work is not stopped" });
      return;
    }
    logger.debug?.(`[host] continued (reset) work ${result.jobId}`);
    res.status(202).json({ work: result });
  });

  // rerun from step: re-execute the caller's work from a chosen step via engine Reset (re-runs that step and all
  // after it). 404 when not the caller's. The UI only offers this on a settled work; a live run the engine refuses,
  // which the worker logs — the host has already optimistically set `running`, healed by reconcile on next refresh.
  router.post("/api/works/:workId/steps/:stepId/rerun", requirePermission("workflow:write"), async (req: Request, res: Response) => {
    const work = await orchestrator.rerunStep(req.params.workId, owner(req), req.params.stepId);
    if (!work) {
      res.status(404).json({ error: "unknown work" });
      return;
    }
    logger.debug?.(`[host] rerun work ${work.jobId} from step ${req.params.stepId}`);
    res.status(202).json({ work });
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
