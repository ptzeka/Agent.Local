import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { Express, Request, Response } from "express";
import type { Eventing, AppSettings } from "@agent-local/common";
import { loadConfig, AGENT_EXECUTE_TASK_TYPE } from "./config.js";
import { ZeebeClient } from "./zeebe-client.js";

// bpmn ships next to dist/ in the package; anchor the default dir here so it resolves regardless of cwd
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface MountContext {
  bus: Eventing;
  logger: any;
  signal: AbortSignal;
  // the host passes the whole appsettings; the engine reads only its `workflow` section
  settings?: AppSettings;
}

// host-called seam: starts the Zeebe client + worker and registers the control surface on the host's express app
// uses ctx.bus to publish (never mints its own) and ctx.signal to stop cleanly when the host aborts. Returns the
// client so the host can fold its Camunda liveness (client.connected) into a composite /healthz; standalone
// callers (main.ts) ignore the return.
export const mount = (app: Express, ctx: MountContext): ZeebeClient => {
  // appsettings supplies non-secret engine knobs; ZEEBE_* connection secrets still come from env via loadConfig
  const config = loadConfig(process.env, packageRoot);
  if (ctx.settings?.workflow?.taskType) config.taskType = ctx.settings.workflow.taskType;
  const client = new ZeebeClient(config, ctx.bus, ctx.logger, ctx.signal);
  void client.start();

  // the host commands a start over the bus (it owns no Zeebe handle); seed the work-unit ids as process
  // variables so every activated job carries them back, then ack with the processInstanceKey as camundaId
  ctx.bus.subscribe("workflow.start", (event) => {
    const { workId, workspaceId, sessionId, workflowId } = event.payload as Record<string, string>;
    const bpmnProcessId = workflowId || "agent-execute-process";
    client
      .startProcess(bpmnProcessId, { workId, workspaceId, sessionId })
      .then((record) =>
        ctx.bus.publish("workflow.started", { workId, camundaId: record.processInstanceKey }),
      )
      .catch((err) => ctx.bus.publish("workflow.failed", { workId, error: String(err) }));
  });

  // the host commands a stop over the bus (user stopped the work); cancel the instance by its camundaId.
  // tolerant — a broker reject is logged, never thrown back onto the bus; the host still records the stop.
  ctx.bus.subscribe("workflow.stop", (event) => {
    const { camundaId } = event.payload as Record<string, string>;
    if (!camundaId) return;
    client.cancelProcess(camundaId).catch((err) => {
      ctx.logger.warn?.(`[workflow] cancel of ${camundaId} failed: ${String(err)}`);
    });
  });

  // a future agent.result drives out-of-band completion; Camunda state refreshes here, agent is never called from this side
  ctx.bus.subscribe("agent.result", (event) => {
    const jobKey = event.payload.jobKey;
    if (typeof jobKey !== "string") return;
    const variables = (event.payload.variables as Record<string, unknown>) ?? {};
    client.completeJob(jobKey, variables).catch((err) => {
      ctx.bus.publish("workflow.failed", {
        processInstanceKey: variables.processInstanceKey,
        jobKey,
        error: String(err),
      });
    });
  });

  app.post("/workflow/process", (req: Request, res: Response) => {
    const bpmnProcessId = req.body?.bpmnProcessId ?? "agent-execute-process";
    const variables = req.body?.variables ?? {};
    client
      .startProcess(bpmnProcessId, variables)
      .then((record) => res.status(201).json(record))
      .catch((err) => res.status(503).json({ error: String(err) }));
  });

  app.get("/workflow/process/:key", (req: Request, res: Response) => {
    const record = client.getInstance(req.params.key);
    if (!record) {
      res.status(404).json({ error: "unknown process instance" });
      return;
    }
    res.json(record);
  });

  app.get("/workflow/healthz", (_req: Request, res: Response) => {
    res.status(client.connected ? 200 : 503).json({
      connected: client.connected,
      taskType: AGENT_EXECUTE_TASK_TYPE,
    });
  });

  return client;
};
