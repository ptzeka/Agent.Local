import { Router, type Request, type Response } from "express";
import { EXECUTE_WORK_PERMISSION, type EventEnvelope } from "@agent-local/common";
import { WORKFLOW_JOB, AGENT_RESULT, WORKFLOW_FAILED, type WorkflowJob } from "./contract.js";
import { type SessionRegistry } from "./session-registry.js";

// the camunda job carries the instruction in a variable; accept the common spellings
function promptFor(variables: Record<string, unknown>): string {
  return String(variables.prompt ?? variables.input ?? variables.task ?? "").trim();
}

// runs one job against the request's runtime and publishes the answer on the request's bus (the sender
// forwards it to the host); a turn-level failure surfaces as WORKFLOW_FAILED instead. The runtime lives
// only for this job, so it is drained in finally — the session flushes to disk and MCP clients close.
async function runJob(req: Request, job: WorkflowJob): Promise<void> {
  try {
    const prompt = promptFor(job.variables ?? {});
    if (!prompt) {
      req.eventing.publish(WORKFLOW_FAILED, {
        processInstanceKey: job.processInstanceKey,
        jobKey: job.jobKey,
        error: "agent job carried no prompt/input/task variable",
      });
      return;
    }
    const result = await req.agentRuntime.dispatchAsync(prompt, { signal: req.runtimeSignal });
    const text = result.finalMessage.content;
    // jobKey is the host's correlation key; the session is internal to this server, so it isn't echoed back
    req.eventing.publish(AGENT_RESULT, {
      processInstanceKey: job.processInstanceKey,
      jobKey: job.jobKey,
      result: text,
      // returned DOWN to camunda by workflow.completeJob(jobKey, variables)
      variables: { agentResult: text, processInstanceKey: job.processInstanceKey },
    });
  } finally {
    await req.closeRuntime();
  }
}

// session lifecycle API: minting/closing a work session needs no runtime, so it mounts BEFORE the runtime
// middleware (which would otherwise build a runtime — and spurious session/sandbox state — per request).
// /session/create is privileged: gated on EXECUTE_WORK_PERMISSION from the verified token. The host owns
// workId (the unit) and workspaceId (the shared folder guid) and passes both; the agent mints the sessionId.
export function createSessionApi(sessions: SessionRegistry): Router {
  const router = Router();

  router.post("/session/create", (req: Request, res: Response) => {
    if (!req.userContext?.permissions?.includes(EXECUTE_WORK_PERMISSION)) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    const { workspaceId, workId } = (req.body ?? {}) as { workspaceId?: string; workId?: string };
    if (!workspaceId || !workId) {
      res.status(400).json({ error: "workspaceId and workId are required" });
      return;
    }
    const record = sessions.create(workspaceId, workId);
    res.status(201).json({ sessionId: record.sessionId });
  });

  router.post("/session/close", (req: Request, res: Response) => {
    const { sessionId } = (req.body ?? {}) as { sessionId?: string };
    res.status(202).json({ closed: sessionId ? sessions.close(sessionId) : false });
  });

  return router;
}

// receive API: the host's sender posts here. The runtime, bus and signal for the call are already resolved
// onto req by the context middleware (a fresh runtime per request), so handlers read them off req — no
// injected manager. /events runs a job and reports back, draining its runtime when done.
export function createApi(): Router {
  const router = Router();

  // envelope receiver { eventType, payload }. The answer returns out-of-band via the sender's webhook, so
  // this responds 202 immediately (fire-and-forget) rather than blocking on the runtime turn.
  router.post("/events", (req: Request, res: Response) => {
    const envelope = req.body as EventEnvelope;
    if (envelope?.eventType !== WORKFLOW_JOB) {
      res.status(400).json({ error: `unsupported eventType ${String(envelope?.eventType)}` });
      return;
    }
    const job = envelope.payload as WorkflowJob;
    void runJob(req, job).catch((err) => req.logger?.error?.("[agent-server] run failed", err));
    res.status(202).json({ accepted: true });
  });

  return router;
}
