import { SessionStore } from "../../session/session-store.js";
import type { IMiddleware, RuntimeContext } from "../types.js";

/**
 * StoreMiddleware — opens the on-disk session store rooted at ctx.sessionsDir.
 *
 * First step in the pipeline: SessionMiddleware and SessionManagerMiddleware
 * both read ctx.store, so this must run before either. Sets ctx.store before
 * calling next().
 */
export class StoreMiddleware implements IMiddleware {
  async initialize(ctx: RuntimeContext, next: () => Promise<void>): Promise<void> {
    ctx.store = SessionStore.create(ctx.sessionsDir);
    await next();
  }
}
