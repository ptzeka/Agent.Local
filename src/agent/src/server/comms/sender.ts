import { type AccessTokenProvider, type Eventing, type ILogger } from "@agent-local/common";
import { EXECUTION_RESULT, type ExecutionResult } from "./contract.js";

// agent -> host SENDER: the bus->HTTP adapter. Subscribes to finished runs and POSTs the neutral ExecutionResult
// to the host's /receive. Transport is swappable (HTTP webhook now, gRPC later); it speaks no engine vocabulary.
export class HttpResultSender {
  constructor(
    private readonly bus: Eventing,
    private readonly receiveUrl: string,
    private readonly logger: ILogger,
    private readonly tokens?: AccessTokenProvider,
    private readonly clientId?: string,
  ) {}

  // bus binding: every finished run is POSTed to the host webhook
  start(): void {
    this.bus.subscribe(EXECUTION_RESULT, (event) => {
      void this.send(event.payload as unknown as ExecutionResult).catch((err) =>
        this.logger.error?.("[agent-server] webhook post failed", err),
      );
    });
  }

  // POST one ExecutionResult to the host's /receive. the cached service bearer (refreshed only past expiry) is
  // null when unconfigured so local dev still posts. throws on non-2xx so start()'s catch logs it.
  async send(result: ExecutionResult): Promise<void> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    const token = this.clientId ? await this.tokens?.getAccessTokenAsync(this.clientId) : undefined;
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(this.receiveUrl, { method: "POST", headers, body: JSON.stringify(result) });
    if (!res.ok) throw new Error(`webhook ${this.receiveUrl} -> ${res.status}`);
  }
}
