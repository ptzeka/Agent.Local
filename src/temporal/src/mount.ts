import { randomUUID } from "node:crypto";
import type { Express, Request, Response } from "express";
import type { Eventing, AppSettings } from "@agent-local/common";
import { loadConfig } from "./config.js";
import { TemporalClient, WorkflowDisabledError } from "./temporal-client.js";
import { createTemporalCore } from "./temporal-core.js";
import { startWorker } from "./worker.js";

export interface MountContext {
  bus: Eventing;
  logger: any;
  signal: AbortSignal;
  // the host passes the whole appsettings; the engine reads only its `workflow` section
  settings?: AppSettings;
}

// host-called seam: starts the Temporal client and registers the control surface on the host's express app.
// the host couples to the engine only through the bus (mount(app, ctx) is the only direct call); uses ctx.bus
// to publish (never mints its own) and ctx.signal to stop cleanly; returns the client so the host can fold its
// liveness (client.connected) into a composite /healthz.
export const mount = (app: Express, ctx: MountContext): TemporalClient => {
  // appsettings supplies non-secret engine knobs; TEMPORAL_* connection details still come from env via loadConfig.
  // the `workflow` settings section is engine-neutral: taskType -> taskQueue, enabledProcessIds -> enabledWorkflowTypes
  const config = loadConfig(process.env);
  if (ctx.settings?.workflow?.taskType) config.taskQueue = ctx.settings.workflow.taskType;
  if (ctx.settings?.workflow?.enabledProcessIds) config.enabledWorkflowTypes = ctx.settings.workflow.enabledProcessIds;
  // inject the real @temporalio/client adapter; the server is live, so every control-surface action now reaches it
  const client = new TemporalClient(config, ctx.bus, ctx.logger, ctx.signal, createTemporalCore(config));
  void client.start();

  // co-hosted worker: shares ctx.bus so dispatchAgentTask reaches the agent; tolerant — a server down at boot logs,
  // never crashes the host (the client's own reconnect covers the control surface meanwhile)
  startWorker(config, ctx.bus, ctx.logger, ctx.signal).catch((err) =>
    ctx.logger.warn?.(`[temporal] worker failed to start: ${String(err)}`),
  );

  // the host commands a start over the bus; the Temporal WorkflowId is our workId, so dedup is free and every
  // later op keys by it. the engine instance id (temporalId) it returns here equals workId.
  ctx.bus.subscribe("workflow.start", (event) => {
    const { workId, workspaceId, sessionId, workflowId } = event.payload as Record<string, string>;
    const workflowType = workflowId || config.defaultWorkflowType;
    client
      .startProcess(workflowType, workId, { workId, workspaceId, sessionId })
      .then((record) => ctx.bus.publish("workflow.started", { workId, temporalId: record.workflowId }))
      .catch((err) => ctx.bus.publish("workflow.failed", { workId, error: String(err) }));
  });

  // the host commands a stop over the bus (user stopped the work); cancel the execution by its id.
  // tolerant — a server reject is logged, never thrown back onto the bus; the host still records the stop.
  ctx.bus.subscribe("workflow.stop", (event) => {
    const { temporalId } = event.payload as Record<string, string>;
    if (!temporalId) return;
    client.cancelProcess(temporalId).catch((err) => {
      ctx.logger.warn?.(`[temporal] cancel of ${temporalId} failed: ${String(err)}`);
    });
  });

  // the host authorizes then commands a variable injection; the engine delivers it as a Signal. tolerant like stop.
  ctx.bus.subscribe("workflow.inject", (event) => {
    const { temporalId, variables } = event.payload as Record<string, unknown>;
    if (typeof temporalId !== "string") return;
    client.setVariables(temporalId, (variables ?? {}) as Record<string, unknown>).catch((err) => {
      ctx.logger.warn?.(`[temporal] inject into ${temporalId} failed: ${String(err)}`);
    });
  });

  // the host authorizes then commands a "continue": Reset the execution so its stuck step re-runs with the same
  // inputs. tolerant like stop — a server reject (e.g. the workflow is running) is logged, never thrown onto the bus.
  ctx.bus.subscribe("workflow.reset", (event) => {
    const { workId, stepId } = event.payload as Record<string, string>;
    if (!workId) return;
    // stepId present -> rerun from that step (NONE reapply); absent -> Continue (reset to the last task boundary)
    const reset = stepId ? client.rerunFromStep(workId, stepId) : client.resetProcess(workId);
    reset.catch((err) => {
      ctx.logger.warn?.(`[temporal] reset of ${workId}${stepId ? ` from step ${stepId}` : ""} failed: ${String(err)}`);
    });
  });

  // Temporal retries activities by built-in policy; manual retry is a reset (M7-9). Inert here — log so the seam
  // stays parallel to the Zeebe mount without faking incident semantics Temporal does not have.
  ctx.bus.subscribe("workflow.retry", () => {
    ctx.logger.info?.("[temporal] workflow.retry is engine-managed (built-in activity retry); no-op");
  });

  // reconcile request: the host asks for a work's live state; answer with the engine's authoritative describe.
  // getInstance returns undefined when Temporal has no such workflow — report `missing` so the host marks it stuck.
  ctx.bus.subscribe("workflow.describe", (event) => {
    const { workId } = event.payload as Record<string, string>;
    if (!workId) return;
    client
      .getInstance(workId)
      .then((record) =>
        ctx.bus.publish("workflow.status", record
          ? { workId, status: record.status }
          : { workId, missing: true }),
      )
      .catch((err) => ctx.logger.warn?.(`[temporal] describe of ${workId} failed: ${String(err)}`));
  });

  // the agent reports results; the WORKFLOW decides done/next. deliver as a signal — NOT a completion.
  // PoC reuses the existing id field; the terminal workflow.completed/failed publish lands with the worker.
  ctx.bus.subscribe("agent.result", (event) => {
    const payload = event.payload as Record<string, unknown>;
    const temporalId = payload.temporalId as string | undefined;
    if (typeof temporalId !== "string") return;
    // outcome rides the signal so the workflow can fail a step on a non-satisfied turn (see user-table-test.ts)
    client.reportResult(temporalId, payload.result, payload.outcome as string | undefined).catch((err) => {
      ctx.bus.publish("workflow.failed", { temporalId, error: String(err) });
    });
  });

  // ---------------------------------------------------------------------------
  // Control surface: the host's /workflow/* routes, served by the Temporal client
  // ---------------------------------------------------------------------------

  app.post("/workflow/process", (req: Request, res: Response) => {
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
