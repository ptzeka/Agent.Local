import { type AccessTokenProvider, type Eventing, type ILogger, type EventEnvelope, type ISender } from "@agent-local/common";
import { AGENT_RESULT } from "./contract.js";

// agent -> host SENDER: forwards a finished turn back to the host. The transport is swappable (HTTP webhook
// now, gRPC later); the body is the SAME event in envelope form, so the host receiver just republishes it.
export class HttpResultSender implements ISender {
  constructor(
    private readonly bus: Eventing,
    private readonly receiveUrl: string,
    private readonly logger: ILogger,
    private readonly tokens?: AccessTokenProvider,
    private readonly clientId?: string,
  ) {}

  // bus binding: every finished turn (agent.result) is wrapped as an envelope and send()s to the host webhook
  start(): void {
    this.bus.subscribe(AGENT_RESULT, (event) => {
      void this.send({ eventType: AGENT_RESULT, payload: event.payload }).catch((err) =>
        this.logger.error?.("[agent-server] webhook post failed", err),
      );
    });
  }

  // ISender: POST one event envelope to the host's /receive. the cached service bearer (refreshed only past
  // expiry) is null when unconfigured so local dev still posts. throws on non-2xx so start()'s catch logs it.
  async send(envelope: EventEnvelope): Promise<void> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    const token = this.clientId ? await this.tokens?.getAccessTokenAsync(this.clientId) : undefined;
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(this.receiveUrl, { method: "POST", headers, body: JSON.stringify(envelope) });
    if (!res.ok) throw new Error(`webhook ${this.receiveUrl} -> ${res.status}`);
  }
}
