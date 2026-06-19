import { Router, type Request, type Response } from "express";
import type { ILogger } from "@agent-local/common";
import { requirePermission } from "../user/userContext.js";
import type { JobRegistry, JobStatus } from "../jobs/job-registry.js";
import type { Orchestrator } from "../orchestrator.js";

// the user-scoped work API: the host BFF resource over the work-unit registry. Every route is gated AND scoped
// to the caller's identity (req.userContext.userInfo.sub, set by userContextMiddleware) so a user only ever
// sees or stops their OWN works. "save" is just create for now (edit deferred); create runs the trigger flow.
export function createWorksApi(orchestrator: Orchestrator, jobs: JobRegistry, logger: ILogger): Router {
  const router = Router();

  // the owner of THIS request; requirePermission guarantees userInfo is non-null before these handlers run
  const owner = (req: Request): string => req.userContext.userInfo!.sub;

  // search: the caller's works, optionally narrowed by ?status=. newest-first (registry sorts).
  router.get("/api/works", requirePermission("workflow:read"), async (req: Request, res: Response) => {
    const status = typeof req.query.status === "string" ? (req.query.status as JobStatus) : undefined;
    const works = await jobs.search({ userId: owner(req), status });
    res.json({ works });
  });

  // get: one work's current state by workId; 404 unless it exists AND belongs to the caller (no leak of ids)
  router.get("/api/works/:workId", requirePermission("workflow:read"), async (req: Request, res: Response) => {
    const work = await jobs.get(req.params.workId);
    if (!work || work.userId !== owner(req)) {
      res.status(404).json({ error: "unknown work" });
      return;
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
