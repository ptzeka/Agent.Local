import { InputInbox } from "../../runners/input-inbox.js";
import type { IMiddleware, RuntimeContext } from "../types.js";

/**
 * InputInboxMiddleware — creates the external input injection seam the
 * orchestrator drains at the start of each iteration.
 *
 * Has no dependencies of its own; SessionManagerMiddleware reads ctx.inbox, so
 * this must run earlier. Sets ctx.inbox before calling next().
 */
export class InputInboxMiddleware implements IMiddleware {
  async initialize(ctx: RuntimeContext, next: () => Promise<void>): Promise<void> {
    ctx.inbox = new InputInbox();
    await next();
  }
}
