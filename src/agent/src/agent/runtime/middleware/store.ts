import { SessionStore } from "../../session/session-store.js";
import { StoreToken } from "../tokens.js";
import type { IMiddleware, RuntimeContext } from "../types.js";

// opens the session store; must run before Session/SessionManager middleware, which read the store
export class StoreMiddleware implements IMiddleware {
  async initialize(ctx: RuntimeContext, next: () => Promise<void>): Promise<void> {
    ctx.registry.set(StoreToken, SessionStore.create(ctx.sessionsDir));
    await next();
  }
}
