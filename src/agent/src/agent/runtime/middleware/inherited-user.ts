import type { Principal } from "../../identity/types.js";
import type { IMiddleware, RuntimeContext } from "../types.js";

/**
 * InheritedUserMiddleware — the sub-runtime's replacement for the Identity +
 * Anonymous steps. A sub-session does not authenticate; it adopts its parent's
 * resolved identity wholesale, so the child's persisted record carries the same
 * principal the parent ran under. Sets ctx.user before calling next().
 *
 * The value is whatever the parent resolved to (an authenticated principal, or
 * the anonymous fallback the top-level pipeline always lands on) — undefined is
 * tolerated but should not occur, since the top-level chain guarantees a user.
 */
export class InheritedUserMiddleware implements IMiddleware {
  constructor(private readonly user: Principal | undefined) {}

  async initialize(ctx: RuntimeContext, next: () => Promise<void>): Promise<void> {
    ctx.user = this.user;
    await next();
  }
}
