import { basicAuthHeader, type Eventing, type ILogger, type EventEnvelope } from "@agent-local/common";
import { AGENT_RESULT } from "./contract.js";

// the agent's client-credentials for fetching its own bearer; omitted when unconfigured (local dev fallback)
export interface ServiceCredentials {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
}

// agent -> host SENDER: forwards a finished turn back to the host. The transport is swappable (HTTP webhook
// now, gRPC later); the body is the SAME event in envelope form, so the host receiver just republishes it.
export interface ResultSender {
  start(): void;
}

export class HttpResultSender implements ResultSender {
  constructor(
    private readonly bus: Eventing,
    private readonly receiveUrl: string,
    private readonly logger: ILogger,
    private readonly credentials?: ServiceCredentials,
  ) {}

  start(): void {
    this.bus.subscribe(AGENT_RESULT, (event) => {
      void this.post({ eventType: AGENT_RESULT, payload: event.payload });
    });
  }

  private async post(envelope: EventEnvelope): Promise<void> {
    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      // fetch a fresh short-lived token per post and discard it; the host gates /receive on the bearer's claims
      const token = await this.fetchToken();
      if (token) headers.authorization = `Bearer ${token}`;
      const res = await fetch(this.receiveUrl, { method: "POST", headers, body: JSON.stringify(envelope) });
      if (!res.ok) this.logger.error?.(`[agent-server] webhook ${this.receiveUrl} -> ${res.status}`);
    } catch (err) {
      this.logger.error?.("[agent-server] webhook post failed", err);
    }
  }

  // client-credentials grant against the host's /api/auth/token; null when unconfigured so local dev still posts
  private async fetchToken(): Promise<string | null> {
    if (!this.credentials) return null;
    const { tokenUrl, clientId, clientSecret } = this.credentials;
    const res = await fetch(tokenUrl, { method: "POST", headers: { authorization: basicAuthHeader(clientId, clientSecret) } });
    if (!res.ok) {
      this.logger.error?.(`[agent-server] token fetch ${tokenUrl} -> ${res.status}`);
      return null;
    }
    return ((await res.json()) as { token?: string }).token ?? null;
  }
}
