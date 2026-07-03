import { randomUUID } from "node:crypto";
import { type AccessTokenProvider, type Eventing, type ILogger } from "@agent-local/common";
import { WORKFLOW_JOB, WORKFLOW_FAILED, type WorkflowJobPayload, type ExecutionRequest } from "./contract.js";

// host -> agent SENDER: forwards workflow jobs to the agent over HTTP, minting a per-step session (via the
// StepSessionResolver) for each dispatch. Transport is swappable (HTTP now, gRPC later) behind these interfaces. It
// translates the engine's job into a neutral ExecutionRequest — runId carries the host's temporalId (== workId)
// opaquely, so the agent's reply round-trips back to THIS work via the runId it echoes.
export interface AgentClient {
  // subjectToken (the caller's access token) is exchanged for an OBO bearer so the agent owns the session by the
  // USER (cli); omit it for a workflow job session, which the host's own dispatch token owns (the workflow-user).
  // sessionId carries the host's cached session so the agent reuses it when still valid, else mints a new one.
  createSession(workspaceId: string, workId: string, subjectToken?: string | null, sessionId?: string): Promise<string>;
  closeSession(sessionId: string): Promise<void>;
  // the live interactive CLI half: open the agent's SSE event stream for a session (to pipe to the browser), and
  // push one input turn into that session. BOTH carry the USER — subjectToken (the caller's access token) is
  // exchanged for an OBO bearer so the agent verifies the user itself: it binds the stream to the session's owner
  // and refuses input into a user-bound session from anyone else.
  openSseStream(sessionId: string, subjectToken: string | null, signal: AbortSignal): Promise<Response>;
  sendInput(sessionId: string, input: string, subjectToken?: string | null): Promise<void>;
  // chat Stop: cancel the session's in-flight turn but keep the session open for the next input. Rides the OBO
  // user bearer (subjectToken) so the agent matches the caller against the session's owner.
  interruptSession(sessionId: string, subjectToken?: string | null): Promise<void>;
}

// the job carries the instruction in a variable; accept the common spellings
function promptFor(variables: Record<string, unknown>): string {
  return String(variables.prompt ?? variables.input ?? variables.task ?? "").trim();
}

// port the sender calls to bind a session to the step it is about to dispatch — implemented by WorkService, which
// owns the work state. Keeps the sender pure transport (it mints/persists nothing) while the session is created on
// the host the moment a step is dispatched. `open` is idempotent per (workId, runKey, stepKey) so activity retries
// reuse one session; `close` releases a session whose dispatch never reached the agent.
export interface StepSessionResolver {
  open(workId: string, runKey: string, stepKey: string): Promise<string>;
  close(sessionId: string): Promise<void>;
}

export class HttpJobSender implements AgentClient {
  // set once at wiring (after WorkService exists) so the WORKFLOW_JOB handler can mint a per-step session
  private stepSessions?: StepSessionResolver;

  constructor(
    private readonly bus: Eventing,
    private readonly baseUrl: string,
    private readonly logger: ILogger,
    private readonly tokens?: AccessTokenProvider,
    private readonly clientId?: string,
  ) {}

  setStepSessionResolver(resolver: StepSessionResolver): void {
    this.stepSessions = resolver;
  }

  // bus binding: mint this step's own session, then translate the engine job into a neutral ExecutionRequest and
  // POST it to the agent's /receive. A failure (no resolver, mint failed, or the POST) fails the workflow step.
  start(): void {
    this.bus.subscribe(WORKFLOW_JOB, (event) => {
      const job = event.payload as unknown as WorkflowJobPayload;
      void this.dispatchStep(job).catch((err) => {
        this.logger.error?.("[agent-client] dispatch failed", err);
        this.bus.publish(WORKFLOW_FAILED, {
          temporalId: job.temporalId,
          jobKey: job.jobKey,
          error: String(err),
        });
      });
    });
  }

  // open the step's session via the resolver, then dispatch under it; if the POST never reaches the agent, close
  // the just-opened session so it is not later swept as if it were live work.
  private async dispatchStep(job: WorkflowJobPayload): Promise<void> {
    if (!this.stepSessions) throw new Error("[agent-client] no StepSessionResolver wired");
    const variables = job.variables ?? {};
    const runKey = String(variables.runKey ?? "");
    const stepKey = String(variables.stepKey ?? "");
    const sessionId = await this.stepSessions.open(job.temporalId, runKey, stepKey);
    const request: ExecutionRequest = { runId: job.temporalId, input: promptFor(variables) };
    try {
      await this.dispatch(request, sessionId);
    } catch (err) {
      await this.stepSessions.close(sessionId);
      throw err;
    }
  }

  // the agent derives the session OWNER from the bearer's subject: an OBO bearer (subjectToken present) owns it by
  // the user for a cli session; the plain dispatch token (no subject) owns it by the workflow-user for a job.
  async createSession(workspaceId: string, workId: string, subjectToken: string | null = null, sessionId?: string): Promise<string> {
    const res = await this.post("/session/create", { workspaceId, workId, sessionId }, undefined, await this.userBearer(subjectToken));
    if (!res.ok) throw new Error(`agent /session/create -> ${res.status}`);
    const { sessionId: resolved } = (await res.json()) as { sessionId: string };
    return resolved;
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
  // turn since these are conversational, not a single workflow run). Rides the OBO user bearer, not the service
  // token, so the agent can match the caller against the session's owner. throws on non-2xx so the route can 502.
  async sendInput(sessionId: string, input: string, subjectToken: string | null = null): Promise<void> {
    const request: ExecutionRequest = { runId: randomUUID(), input };
    const res = await this.post("/receive", request, sessionId, await this.userBearer(subjectToken));
    if (!res.ok) throw new Error(`agent /receive -> ${res.status}`);
  }

  // POST a Stop for the session's live turn: the agent cancels the in-flight turn but leaves the runtime up. Rides
  // the OBO user bearer so the agent can match the caller against the session's owner. throws on non-2xx so the
  // route can surface it; a no-op (no live turn) still answers 202.
  async interruptSession(sessionId: string, subjectToken: string | null = null): Promise<void> {
    const res = await this.post("/session/interrupt", { sessionId }, undefined, await this.userBearer(subjectToken));
    if (!res.ok) throw new Error(`agent /session/interrupt -> ${res.status}`);
  }

  // POST one execution request to the agent's /receive. the host presents its OWN agent:trigger service token
  // (the agent validates the bearer); the work unit's sessionId rides as a header so the agent binds the runtime
  // to that session. throws on non-2xx so start()'s catch can fail the workflow step.
  private async dispatch(request: ExecutionRequest, sessionId: string): Promise<void> {
    const res = await this.post("/receive", request, sessionId);
    if (!res.ok) throw new Error(`agent /receive -> ${res.status}`);
  }

  private async post(path: string, body?: unknown, sessionId?: string, bearer?: string | null): Promise<Response> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    // an explicit bearer (the OBO user token) wins; else the cached agent:trigger service bearer (refreshed only
    // past expiry); null/undefined in unconfigured dev sends no header. the agent gates on the token's claims
    const token = bearer ?? (this.clientId ? await this.tokens?.getAccessTokenAsync(this.clientId) : undefined);
    if (token) headers.authorization = `Bearer ${token}`;
    if (sessionId) headers["x-session-id"] = sessionId;
    return fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
}
