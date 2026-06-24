import { randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import type { TemporalConfig } from "../config.js";
import { TemporalClient, WorkflowDisabledError } from "../temporal-client.js";

// the engine's HTTP control surface: the host's /workflow/* routes, served by the Temporal client. Split out of
// mount.ts so the seam there is bus wiring only; this is the synchronous request/response half. Mounted on the
// host's express app as a Router (absolute /workflow/* paths preserved), so the host owns the listener.
export function createWorkflowApi(client: TemporalClient, config: TemporalConfig): Router {
  const router = Router();

  router.post("/workflow/process", (req: Request, res: Response) => {
    // Temporal needs a WorkflowId, so mint one if the caller didn't supply a workId
    const workflowType = req.body?.workflowType ?? config.defaultWorkflowType;
    const workId = req.body?.workId ?? randomUUID();
    const variables = req.body?.variables ?? {};
    client
      .startProcess(workflowType, workId, variables)
      .then((record) => res.status(201).json(record))
      .catch((err) => {
        // a disabled workflow is a client-side refusal (403), not a server outage (503)
        const status = err instanceof WorkflowDisabledError ? 403 : 503;
        res.status(status).json({ error: String(err) });
      });
  });

  router.get("/workflow/process/:key", (req: Request, res: Response) => {
    client
      .getInstance(req.params.key)
      .then((record) => {
        if (!record) {
          res.status(404).json({ error: "unknown execution" });
          return;
        }
        res.json(record);
      })
      .catch((err) => res.status(503).json({ error: String(err) }));
  });

  router.get("/workflow/healthz", (_req: Request, res: Response) => {
    res.status(client.connected ? 200 : 503).json({
      connected: client.connected,
      taskQueue: config.taskQueue,
    });
  });

  return router;
}
