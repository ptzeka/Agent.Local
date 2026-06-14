import { Eventing } from "../../../common/eventing.js";
import type { IMiddleware, RuntimeContext } from "../types.js";

export interface EventingMiddlewareParams {
  // host's bus this runtime chains under; omitted for a sub-runtime, whose bus is its own root
  parent?: Eventing;
}

// chains this runtime's bus under the host's so the turn publishes here instead of via an onEvent callback
export class EventingMiddleware implements IMiddleware {
  constructor(private readonly params: EventingMiddlewareParams = {}) {}

  async initialize(ctx: RuntimeContext, next: () => Promise<void>): Promise<void> {
    // reuse a bus the runtime already owns (reset/compact rebuild) so a host's one-time subscription survives
    ctx.eventing ??= new Eventing();
    // idempotent: add dedupes parents in a Set, so re-chaining on rebuild is safe
    this.params.parent?.add(ctx.eventing);
    await next();
  }
}
