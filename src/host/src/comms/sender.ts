import { type AccessTokenProvider, type Eventing, type ILogger } from "@agent-local/common";
import { WORKFLOW_JOB, WORKFLOW_FAILED, type WorkflowJobPayload, type ExecutionRequest } from "./contract.js";

// host -> agent SENDER: the work service opens/closes a session per work unit, then this forwards workflow jobs
// to the agent service over HTTP. Transport is swappable (HTTP now, gRPC later) behind these interfaces. It
// translates the engine's job into a neutral ExecutionRequest — runId carries the host's temporalId (== workId)
// opaquely, so the agent's reply round-trips back to THIS work via the runId it echoes.
export interface AgentClient {
  createSession(workspaceId: string, workId: string): Promise<string>;
  closeSession(sessionId: string): Promise<void>;
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
