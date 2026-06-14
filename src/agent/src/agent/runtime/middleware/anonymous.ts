import { ANONYMOUS_PRINCIPAL } from "../../identity/types.js";
import { UserToken } from "../tokens.js";
import type { IMiddleware, RuntimeContext } from "../types.js";

// fallback so the user is always set after the identity phase; place after Identity, before Session
export class AnonymousMiddleware implements IMiddleware {
  async initialize(ctx: RuntimeContext, next: () => Promise<void>): Promise<void> {
    if (!ctx.registry.has(UserToken)) {
      ctx.registry.set(UserToken, ANONYMOUS_PRINCIPAL);
    }
    await next();
  }
}
