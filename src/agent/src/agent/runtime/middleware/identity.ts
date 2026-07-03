import { decodePrincipal } from "../../identity/decode-token.js";
import { UserToken } from "../tokens.js";
import type { IMiddleware, RuntimeContext } from "../types.js";

// resolves a Principal from ctx credentials, leaving the user unset on failure so AnonymousMiddleware takes over
export class IdentityMiddleware implements IMiddleware {
  async initialize(ctx: RuntimeContext, next: () => Promise<void>): Promise<void> {
    const principal = decodePrincipal(ctx.credentials.token);
    if (principal) {
      ctx.registry.set(UserToken, principal);
    }
    await next();
  }
}
