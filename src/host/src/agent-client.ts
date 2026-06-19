import type { Eventing, ILogger, EventEnvelope } from "@agent-local/common";
import { WORKFLOW_JOB, WORKFLOW_FAILED, type WorkflowJobPayload } from "./events.js";

// the agent SERVICE over HTTP: the orchestrator opens/closes a session per work unit, the sender forwards
// camunda jobs. Transport is swappable (HTTP now, gRPC later) behind these interfaces; the /events body is
// the same WORKFLOW_JOB event in envelope form, so the agent runs it exactly as if it came off a bus.
export interface AgentClient {
  // opens a session bound to the host's work unit; authHeader carries the caller's bearer JWT (executework)
  createSession(workspaceId: string, workId: string, authHeader?: string): Promise<string>;
  closeSession(sessionId: string): Promise<void>;
}

export interface JobSender {
  start(): void;
}

export class HttpJobSender implements JobSender, AgentClient {
  constructor(
    private readonly bus: Eventing,
    private readonly baseUrl: string,
    private readonly logger: ILogger,
  ) {}

  // the session is created up front at trigger time, so dispatch no longer mints one: it reads the sessionId
  // the engine seeded as a process variable off the job and forwards the job to the agent under it.
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
  }

  async createSession(workspaceId: string, workId: string, authHeader?: string): Promise<string> {
    const res = await this.post("/session/create", { workspaceId, workId }, authHeader);
    if (!res.ok) throw new Error(`agent /session/create -> ${res.status}`);
    const { sessionId } = (await res.json()) as { sessionId: string };
    return sessionId;
  }

  async closeSession(sessionId: string): Promise<void> {
    try {
      await this.post("/session/close", { sessionId });
    } catch (err) {
      this.logger.error?.("[agent-client] session close failed", err);
    }
  }

  private async dispatch(job: WorkflowJobPayload): Promise<void> {
    const sessionId = String((job.variables ?? {}).sessionId ?? "");
    const envelope: EventEnvelope = { eventType: WORKFLOW_JOB, payload: { ...job, sessionId } };
    const res = await this.post("/events", envelope, undefined, sessionId);
    if (!res.ok) throw new Error(`agent /events -> ${res.status}`);
  }

  // sessionId is also sent as a header so the agent resolves the runtime bound to the work unit's session
  private post(path: string, body?: unknown, authHeader?: string, sessionId?: string): Promise<Response> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (authHeader) headers.authorization = authHeader;
    if (sessionId) headers["x-session-id"] = sessionId;
    return fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
}
