import { basicAuthHeader, type Eventing, type ILogger } from "@agent-local/common";
import { WORKFLOW_JOB, WORKFLOW_FAILED, type WorkflowJobPayload, type EventEnvelope } from "./contract.js";

// the host's client-credentials for fetching its own agent:trigger bearer; omitted when unconfigured (dev)
export interface ServiceCredentials {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
}

// host -> agent SENDER: the orchestrator opens/closes a session per work unit, then this forwards camunda jobs
// to the agent service over HTTP. Transport is swappable (HTTP now, gRPC later) behind these interfaces; the
// /events body is the same WORKFLOW_JOB event in envelope form, so the agent runs it as if it came off a bus.
export interface AgentClient {
  createSession(workspaceId: string, workId: string): Promise<string>;
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
    private readonly credentials?: ServiceCredentials,
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

  // the host presents its OWN agent:trigger service token (fetched per call); the agent validates the bearer.
  // sessionId still rides as a header so the agent resolves the runtime bound to the work unit's session.
  private async dispatch(job: WorkflowJobPayload): Promise<void> {
    const sessionId = String((job.variables ?? {}).sessionId ?? "");
    const envelope: EventEnvelope = { eventType: WORKFLOW_JOB, payload: { ...job, sessionId } };
    const res = await this.post("/events", envelope, sessionId);
    if (!res.ok) throw new Error(`agent /events -> ${res.status}`);
  }

  private async post(path: string, body?: unknown, sessionId?: string): Promise<Response> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    // fetch a fresh short-lived agent:trigger token per call and discard it; the agent gates on the bearer's claims
    const token = await this.fetchToken();
    if (token) headers.authorization = `Bearer ${token}`;
    if (sessionId) headers["x-session-id"] = sessionId;
    return fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  // client-credentials grant against the host's own /api/auth/token; null when unconfigured so local dev still posts
  private async fetchToken(): Promise<string | null> {
    if (!this.credentials) return null;
    const { tokenUrl, clientId, clientSecret } = this.credentials;
    const res = await fetch(tokenUrl, { method: "POST", headers: { authorization: basicAuthHeader(clientId, clientSecret) } });
    if (!res.ok) {
      this.logger.error?.(`[agent-client] token fetch ${tokenUrl} -> ${res.status}`);
      return null;
    }
    return ((await res.json()) as { token?: string }).token ?? null;
  }
}
