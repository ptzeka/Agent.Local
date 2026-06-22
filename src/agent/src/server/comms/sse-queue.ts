import type { Response } from "express";
import type { AgentRuntime } from "../../runtime.js";

// one live CLI connection: the SSE response chat frames are written to, plus the per-connection runtime that
// produces them. The runtime lives for the connection's lifetime — built on attach, drained on disconnect.
export interface SseConnection {
  sessionId: string;
  res: Response;
  runtime: AgentRuntime;
}

// in-memory registry of live SSE connections keyed by sessionId. The SSE route registers one on attach and
// removes it on disconnect; the runner looks one up to route input into its live runtime instead of spawning a
// one-shot job runtime. One connection per session for now (a second attach is refused), matching one CLI tab
// per work. In-memory by design: a process restart drops live streams, which the client simply reconnects.
export class SseQueue {
  private readonly byId = new Map<string, SseConnection>();

  register(connection: SseConnection): void {
    this.byId.set(connection.sessionId, connection);
  }

  get(sessionId: string): SseConnection | undefined {
    return this.byId.get(sessionId);
  }

  has(sessionId: string): boolean {
    return this.byId.has(sessionId);
  }

  // remove only when the stored connection is the one closing, so a replaced connection's late close is a no-op
  deregister(sessionId: string, connection: SseConnection): void {
    if (this.byId.get(sessionId) === connection) this.byId.delete(sessionId);
  }
}
