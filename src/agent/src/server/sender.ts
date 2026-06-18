import type { Eventing, ILogger, EventEnvelope } from "@agent-local/common";
import { AGENT_RESULT } from "./contract.js";

// forwards a finished turn back to the host. The transport is swappable (HTTP webhook now, gRPC later);
// the body is the SAME event in envelope form, so the host receiver just republishes it onto its bus.
export interface ResultSender {
  start(): void;
}

export class HttpResultSender implements ResultSender {
  constructor(
    private readonly bus: Eventing,
    private readonly receiveUrl: string,
    private readonly logger: ILogger,
  ) {}

  start(): void {
    this.bus.subscribe(AGENT_RESULT, (event) => {
      void this.post({ eventType: AGENT_RESULT, payload: event.payload });
    });
  }

  private async post(envelope: EventEnvelope): Promise<void> {
    try {
      const res = await fetch(this.receiveUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(envelope),
      });
      if (!res.ok) this.logger.error?.(`[agent-server] webhook ${this.receiveUrl} -> ${res.status}`);
    } catch (err) {
      this.logger.error?.("[agent-server] webhook post failed", err);
    }
  }
}
