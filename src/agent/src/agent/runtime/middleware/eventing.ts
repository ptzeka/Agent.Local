import { Eventing } from "../../../common/eventing.js";
import type { IMiddleware, RuntimeContext } from "../types.js";

export interface EventingMiddlewareParams {
  /** The host's bus. This runtime's own bus chains under it (parent.add(child)),
   *  so what the turn publishes bubbles up to the host. Omitted for a sub-runtime,
   *  whose bus is its own root (the parent reaches it via the executor MCP bridge). */
  parent?: Eventing;
}

/**
 * EventingMiddleware — creates this runtime's event bus and chains it under the
 * host's, the upward mirror of the cancellation scope. Downstream consumers (the
 * orchestrator's turn) publish here instead of being handed an onEvent callback.
 */
export class EventingMiddleware implements IMiddleware {
  constructor(private readonly params: EventingMiddlewareParams = {}) {}

  async initialize(ctx: RuntimeContext, next: () => Promise<void>): Promise<void> {
    const events = new Eventing();
    this.params.parent?.add(events);
    ctx.eventing = events;
    await next();
  }
}
