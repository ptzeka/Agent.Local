import { randomUUID } from "node:crypto";
import type { Express, Request, Response } from "express";
import type { Eventing, AppSettings } from "@agent-local/common";
import { loadConfig } from "./config.js";
import { TemporalClient, WorkflowDisabledError } from "./temporal-client.js";

export interface MountContext {
  bus: Eventing;
  logger: any;
  signal: AbortSignal;
  // the host passes the whole appsettings; the engine reads only its `workflow` section
  settings?: AppSettings;
}

// host-called seam: starts the Temporal client and registers the control surface on the host's express app.
// SAME contract as @agent-local/workflow's mount so the host can mount either engine — the bus is the seam.
// uses ctx.bus to publish (never mints its own) and ctx.signal to stop cleanly; returns the client so the host
// can fold its liveness (client.connected) into a composite /healthz.
export const mount = (app: Express, ctx: MountContext): TemporalClient => {
  // appsettings supplies non-secret engine knobs; TEMPORAL_* connection details still come from env via loadConfig.
  // the `workflow` settings section is engine-neutral: taskType -> taskQueue, enabledProcessIds -> enabledWorkflowTypes
  const config = loadConfig(process.env);
  if (ctx.settings?.workflow?.taskType) config.taskQueue = ctx.settings.workflow.taskType;
  if (ctx.settings?.workflow?.enabledProcessIds) config.enabledWorkflowTypes = ctx.settings.workflow.enabledProcessIds;
  const client = new TemporalClient(config, ctx.bus, ctx.logger, ctx.signal);
  void client.start();

  // the host commands a start over the bus; the Temporal WorkflowId is our workId, so dedup is free and every
  // later op keys by it. PoC reuses the existing `camundaId` field (M7-9 prove-first) — here it equals workId.
  ctx.bus.subscribe("workflow.start", (event) => {
    const { workId, workspaceId, sessionId, workflowId } = event.payload as Record<string, string>;
    const workflowType = workflowId || config.defaultWorkflowType;
    client
      .startProcess(workflowType, workId, { workId, workspaceId, sessionId })
      .then((record) => ctx.bus.publish("workflow.started", { workId, camundaId: record.workflowId }))
      .catch((err) => ctx.bus.publish("workflow.failed", { workId, error: String(err) }));
  });

  // the host commands a stop over the bus (user stopped the work); cancel the execution by its id.
  // tolerant — a server reject is logged, never thrown back onto the bus; the host still records the stop.
  ctx.bus.subscribe("workflow.stop", (event) => {
    const { camundaId } = event.payload as Record<string, string>;
    if (!camundaId) return;
    client.cancelProcess(camundaId).catch((err) => {
      ctx.logger.warn?.(`[temporal] cancel of ${camundaId} failed: ${String(err)}`);
    });
  });

  // the host authorizes then commands a variable injection; the engine delivers it as a Signal. tolerant like stop.
  ctx.bus.subscribe("workflow.inject", (event) => {
    const { camundaId, variables } = event.payload as Record<string, unknown>;
    if (typeof camundaId !== "string") return;
    client.setVariables(camundaId, (variables ?? {}) as Record<string, unknown>).catch((err) => {
      ctx.logger.warn?.(`[temporal] inject into ${camundaId} failed: ${String(err)}`);
    });
  });

  // Temporal retries activities by built-in policy; manual retry is a reset (M7-9). Inert here — log so the seam
  // stays parallel to the Zeebe mount without faking incident semantics Temporal does not have.
  ctx.bus.subscribe("workflow.retry", () => {
    ctx.logger.info?.("[temporal] workflow.retry is engine-managed (built-in activity retry); no-op");
  });

  // the agent reports results; the WORKFLOW decides done/next. deliver as a signal — NOT a completion.
  // PoC reuses the existing id field; the terminal workflow.completed/failed publish lands with the worker.
  ctx.bus.subscribe("agent.result", (event) => {
    const payload = event.payload as Record<string, unknown>;
    const workId = (payload.camundaId ?? payload.processInstanceKey) as string | undefined;
    if (typeof workId !== "string") return;
    client.reportResult(workId, payload.result).catch((err) => {
      ctx.bus.publish("workflow.failed", { processInstanceKey: workId, error: String(err) });
    });
  });

  // ---------------------------------------------------------------------------
  // Control surface (identical routes to @agent-local/workflow)
  // ---------------------------------------------------------------------------

  app.post("/workflow/process", (req: Request, res: Response) => {
    // accept either field for parity with the Zeebe control surface; Temporal needs a WorkflowId, so mint one if absent
    const workflowType = req.body?.workflowType ?? req.body?.bpmnProcessId ?? config.defaultWorkflowType;
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

  app.get("/workflow/process/:key", (req: Request, res: Response) => {
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

  app.get("/workflow/healthz", (_req: Request, res: Response) => {
    res.status(client.connected ? 200 : 503).json({
      connected: client.connected,
      taskQueue: config.taskQueue,
    });
  });

  return client;
};
