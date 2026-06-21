import { type AccessTokenProvider, type Eventing, type ILogger, type ISender } from "@agent-local/common";
import { WORKFLOW_JOB, WORKFLOW_FAILED, type WorkflowJobPayload, type EventEnvelope } from "./contract.js";

// host -> agent SENDER: the work service opens/closes a session per work unit, then this forwards workflow jobs
// to the agent service over HTTP. Transport is swappable (HTTP now, gRPC later) behind these interfaces; the
// /events body is the same WORKFLOW_JOB event in envelope form, so the agent runs it as if it came off a bus.
export interface AgentClient {
  createSession(workspaceId: string, workId: string): Promise<string>;
  closeSession(sessionId: string): Promise<void>;
}

export class HttpJobSender implements ISender, AgentClient {
  constructor(
    private readonly bus: Eventing,
    private readonly baseUrl: string,
    private readonly logger: ILogger,
    private readonly tokens?: AccessTokenProvider,
    private readonly clientId?: string,
  ) {}

  // bus binding: the session is created up front at trigger time, so this no longer mints one — it reads the
  // sessionId the engine seeded as a process variable off the job, wraps the job as an envelope, and send()s it.
  start(): void {
    this.bus.subscribe(WORKFLOW_JOB, (event) => {
      const job = event.payload as unknown as WorkflowJobPayload;
      const sessionId = String((job.variables ?? {}).sessionId ?? "");
      const envelope: EventEnvelope = { eventType: WORKFLOW_JOB, payload: { ...job, sessionId } };
      void this.send(envelope).catch((err) => {
        this.logger.error?.("[agent-client] dispatch failed", err);
        this.bus.publish(WORKFLOW_FAILED, {
          temporalId: job.temporalId,
          jobKey: job.jobKey,
          error: String(err),
        });
      });
    });
  }

  async createSession(workspaceId: string, workId: string): Promise<string> {
    const res = await this.post("/session/create", { workspaceId, workId });
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

  // ISender: forward one event envelope to the agent's /events. the host presents its OWN agent:trigger service
  // token (the agent validates the bearer); the work unit's sessionId rides as a header so the agent binds the
  // runtime to that session. throws on non-2xx so start()'s catch can fail the workflow step.
  async send(envelope: EventEnvelope): Promise<void> {
    const sessionId = String((envelope.payload as { sessionId?: unknown })?.sessionId ?? "");
    const res = await this.post("/events", envelope, sessionId);
    if (!res.ok) throw new Error(`agent /events -> ${res.status}`);
  }

  private async post(path: string, body?: unknown, sessionId?: string): Promise<Response> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    // the cached agent:trigger bearer (refreshed only past expiry); null in unconfigured dev. the agent gates on its claims
    const token = this.clientId ? await this.tokens?.getAccessTokenAsync(this.clientId) : undefined;
    if (token) headers.authorization = `Bearer ${token}`;
    if (sessionId) headers["x-session-id"] = sessionId;
    return fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
}
