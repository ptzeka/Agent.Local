import { InputInbox } from "../../runners/input-inbox.js";
import { InboxToken } from "../tokens.js";
import type { IMiddleware, RuntimeContext } from "../types.js";

// creates the input injection seam; must run before SessionManagerMiddleware, which reads the inbox
export class InputInboxMiddleware implements IMiddleware {
  async initialize(ctx: RuntimeContext, next: () => Promise<void>): Promise<void> {
    ctx.registry.set(InboxToken, new InputInbox());
    await next();
  }
}
