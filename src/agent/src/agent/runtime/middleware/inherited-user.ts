import type { Principal } from "../../identity/types.js";
import { UserToken } from "../tokens.js";
import type { IMiddleware, RuntimeContext } from "../types.js";

// sub-runtime's replacement for Identity+Anonymous: a child adopts the parent's resolved principal wholesale
export class InheritedUserMiddleware implements IMiddleware {
  constructor(private readonly user: Principal | undefined) {}

  async initialize(ctx: RuntimeContext, next: () => Promise<void>): Promise<void> {
    // skip an absent parent principal: get() throws on undefined, so a missing user must stay unset, not stored
    if (this.user) {
      ctx.registry.set(UserToken, this.user);
    }
    await next();
  }
}
