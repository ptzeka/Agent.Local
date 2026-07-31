import { InputInbox } from "../../runners/input-inbox.js";
import { InboxToken } from "../tokens.js";
import type { IMiddleware, RuntimeContext } from "../types.js";

// creates the input injection seam; must run before SessionManagerMiddleware, which reads the inbox
export class InputInboxMiddleware implements IMiddleware {
  async initialize(ctx: RuntimeContext, next: () => Promise<void>): Promise<void> {
    // read off the already-parsed bundle rather than the registry: this step has no other reason
    // to depend on the configuration service, and ordering stays free
    const ttlMs = ctx.config?.models?.orchestration?.idempotencyTtlMs ?? 0;
    ctx.registry.set(InboxToken, new InputInbox({ ttlMs }));
    await next();
  }
}
