import { randomUUID } from "node:crypto";
import { type AccessTokenProvider, type Eventing, type ILogger } from "@agent-local/common";
import { WORKFLOW_JOB, WORKFLOW_FAILED, type WorkflowJobPayload, type ExecutionRequest } from "./contract.js";

// host -> agent SENDER: the work service opens/closes a session per work unit, then this forwards workflow jobs
// to the agent service over HTTP. Transport is swappable (HTTP now, gRPC later) behind these interfaces. It
// translates the engine's job into a neutral ExecutionRequest — runId carries the host's temporalId (== workId)
// opaquely, so the agent's reply round-trips back to THIS work via the runId it echoes.
export interface AgentClient {
  // userId binds a user-facing (cli) session to its owner on the agent; omitted for a workflow job session
  createSession(workspaceId: string, workId: string, userId?: string): Promise<string>;
  closeSession(sessionId: string): Promise<void>;
  // the live interactive CLI half: open the agent's SSE event stream for a session (to pipe to the browser), and
  // push one input turn into that session. The stream carries the USER — subjectToken (the caller's access token)
  // is exchanged for an OBO bearer so the agent verifies the user and binds the stream to the session's owner.
  openSseStream(sessionId: string, subjectToken: string | null, signal: AbortSignal): Promise<Response>;
  sendInput(sessionId: string, input: string): Promise<void>;
}

// the job carries the instruction in a variable; accept the common spellings
function promptFor(variables: Record<string, unknown>): string {
  return String(variables.prompt ?? variables.input ?? variables.task ?? "").trim();
}

export class HttpJobSender implements AgentClient {
  constructor(
    private readonly bus: Eventing,
    private readonly baseUrl: string,
    private readonly logger: ILogger,
    private readonly tokens?: AccessTokenProvider,
    private readonly clientId?: string,
  ) {}

  // bus binding: translate each engine job into a neutral ExecutionRequest and POST it to the agent's /receive
  start(): void {
    this.bus.subscribe(WORKFLOW_JOB, (event) => {
      const job = event.payload as unknown as WorkflowJobPayload;
      const variables = job.variables ?? {};
      const sessionId = String(variables.sessionId ?? "");
      const request: ExecutionRequest = { runId: job.temporalId, input: promptFor(variables) };
      void this.dispatch(request, sessionId).catch((err) => {
        this.logger.error?.("[agent-client] dispatch failed", err);
        this.bus.publish(WORKFLOW_FAILED, {
          temporalId: job.temporalId,
          jobKey: job.jobKey,
          error: String(err),
        });
      });
    });
  }

  async createSession(workspaceId: string, workId: string, userId?: string): Promise<string> {
    const res = await this.post("/session/create", { workspaceId, workId, userId });
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

  // GET the agent's live event stream for a session; the caller pipes the body to the browser and aborts the
  // signal on disconnect so the agent tears the runtime down. The bearer is an OBO token carrying the USER as its
  // subject (this service as the actor), so the agent verifies the user — never a header — and binds the stream.
  async openSseStream(sessionId: string, subjectToken: string | null, signal: AbortSignal): Promise<Response> {
    const headers: Record<string, string> = { accept: "text/event-stream" };
    const token = await this.userBearer(subjectToken);
    if (token) headers.authorization = `Bearer ${token}`;
    return fetch(`${this.baseUrl}/ssereceive/${sessionId}`, { method: "GET", headers, signal });
  }

  // exchange the user's subject token for an OBO bearer (sub=user, act=this service). Falls back to the plain
  // service token when no subject or no credentials exist (dev/staged), mirroring the dispatch path's behaviour.
  private async userBearer(subjectToken: string | null): Promise<string | null | undefined> {
    if (!this.clientId) return undefined;
    if (subjectToken) return this.tokens?.getAccessTokenWithActorAsync(this.clientId, subjectToken);
    return this.tokens?.getAccessTokenAsync(this.clientId);
  }

  // POST one interactive input turn to the session over the SAME /receive envelope as dispatch (fresh runId per
  // turn since these are conversational, not a single workflow run). throws on non-2xx so the route can 502.
  async sendInput(sessionId: string, input: string): Promise<void> {
    const request: ExecutionRequest = { runId: randomUUID(), input };
    const res = await this.post("/receive", request, sessionId);
    if (!res.ok) throw new Error(`agent /receive -> ${res.status}`);
  }

  // POST one execution request to the agent's /receive. the host presents its OWN agent:trigger service token
  // (the agent validates the bearer); the work unit's sessionId rides as a header so the agent binds the runtime
  // to that session. throws on non-2xx so start()'s catch can fail the workflow step.
  private async dispatch(request: ExecutionRequest, sessionId: string): Promise<void> {
    const res = await this.post("/receive", request, sessionId);
    if (!res.ok) throw new Error(`agent /receive -> ${res.status}`);
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
