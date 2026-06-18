import type { Eventing, ILogger, EventEnvelope } from "@agent-local/common";
import {
  WORKFLOW_JOB,
  WORKFLOW_FAILED,
  AGENT_RESULT,
  type WorkflowJobPayload,
  type AgentResultPayload,
} from "./events.js";

// sends camunda jobs to the agent SERVICE over HTTP and owns the correlation table camunda jobKey ->
// agent sessionId. The transport is swappable (HTTP now, gRPC later) behind this interface; the body is
// the same WORKFLOW_JOB event in envelope form, so the agent runs it exactly as if it came off a bus.
export interface JobSender {
  start(): void;
}

export class HttpJobSender implements JobSender {
  // one agent session per camunda job; this map is the host-owned jobKey -> sessionId link
  private readonly sessionByJob = new Map<string, string>();

  constructor(
    private readonly bus: Eventing,
    private readonly baseUrl: string,
    private readonly logger: ILogger,
  ) {}

  start(): void {
    this.bus.subscribe(WORKFLOW_JOB, (event) => {
      const job = event.payload as unknown as WorkflowJobPayload;
      void this.dispatch(job).catch((err) => {
        this.logger.error?.("[agent-client] dispatch failed", err);
        this.bus.publish(WORKFLOW_FAILED, {
          processInstanceKey: job.processInstanceKey,
          jobKey: job.jobKey,
          error: String(err),
        });
      });
    });

    // the receiver republishes the agent's answer onto the bus; close the correlated session when it lands
    this.bus.subscribe(AGENT_RESULT, (event) => {
      const result = event.payload as unknown as AgentResultPayload;
      void this.closeSession(result.jobKey);
    });
  }

  private async dispatch(job: WorkflowJobPayload): Promise<void> {
    const sessionId = await this.sessionFor(job.jobKey);
    const envelope: EventEnvelope = { eventType: WORKFLOW_JOB, payload: { ...job, sessionId } };
    const res = await this.post("/events", envelope);
    if (!res.ok) throw new Error(`agent /events -> ${res.status}`);
  }

  // create a session on the first job for a jobKey, reuse it on retries
  private async sessionFor(jobKey: string): Promise<string> {
    const existing = this.sessionByJob.get(jobKey);
    if (existing) return existing;
    const res = await this.post("/session/create");
    if (!res.ok) throw new Error(`agent /session/create -> ${res.status}`);
    const { sessionId } = (await res.json()) as { sessionId: string };
    this.sessionByJob.set(jobKey, sessionId);
    return sessionId;
  }

  private async closeSession(jobKey: string): Promise<void> {
    const sessionId = this.sessionByJob.get(jobKey);
    if (!sessionId) return;
    this.sessionByJob.delete(jobKey);
    try {
      await this.post(`/session/${sessionId}/close`);
    } catch (err) {
      this.logger.error?.("[agent-client] session close failed", err);
    }
  }

  private post(path: string, body?: unknown): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
}
