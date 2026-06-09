import { ANONYMOUS_PRINCIPAL } from "../../identity/types.js";
import type { IMiddleware, RuntimeContext } from "../types.js";

/**
 * AnonymousMiddleware — fallback identity step.
 *
 * If no earlier middleware set ctx.user (no credentials were presented, or
 * every validator declined), this stamps the session with ANONYMOUS_PRINCIPAL
 * so that ctx.user is always defined after the identity phase.
 *
 * Place this AFTER any real identity middleware and BEFORE SessionMiddleware:
 *
 *   .add(new IdentityMiddleware())    // try JWT / API-key / etc.
 *   .add(new AnonymousMiddleware())   // ensure user is always set
 *   .add(new SessionMiddleware())     // stamps session.user from ctx.user
 */
export class AnonymousMiddleware implements IMiddleware {
  async initialize(ctx: RuntimeContext, next: () => Promise<void>): Promise<void> {
    if (!ctx.user) {
      ctx.user = ANONYMOUS_PRINCIPAL;
    }
    await next();
  }
}
