import { createJwksResolver, jwksUrlFor, verifyIdentity, type JwtKeyResolver } from "@agent-local/common";
import { decodePrincipal } from "../../identity/decode-token.js";
import type { Principal } from "../../identity/types.js";
import { UserToken } from "../tokens.js";
import type { IMiddleware, RuntimeContext } from "../types.js";

// one resolver per authority for the whole process: jose memoizes the JWKS fetch inside the resolver, so the
// server (which builds a runtime per SSE connection / job) reuses the cached key set instead of re-fetching
const resolvers = new Map<string, JwtKeyResolver>();

function resolverFor(authorityUrl: string): JwtKeyResolver {
  let resolver = resolvers.get(authorityUrl);
  if (!resolver) {
    resolver = createJwksResolver(jwksUrlFor(authorityUrl));
    resolvers.set(authorityUrl, resolver);
  }
  return resolver;
}

// resolves a Principal from ctx credentials, leaving the user unset on failure so AnonymousMiddleware takes
// over. When authentication.authorityUrl is configured the token's RS256 signature, expiry, and issuer are
// verified against the authority's JWKS — same gate as the server edge (user_context.ts). Without an authority
// (tests, legacy static-token mode) there is nothing to verify against, so it decodes claims only.
export class IdentityMiddleware implements IMiddleware {
  async initialize(ctx: RuntimeContext, next: () => Promise<void>): Promise<void> {
    const principal = await this.authenticate(ctx);
    if (principal) {
      ctx.registry.set(UserToken, principal);
    }
    await next();
  }

  private async authenticate(ctx: RuntimeContext): Promise<Principal | null> {
    const token = ctx.credentials.token;
    if (!token) return null;

    const authorityUrl = ctx.config.settings.authentication?.authorityUrl;
    if (!authorityUrl) return decodePrincipal(token);

    try {
      // the verify is a pure gate; the Principal still comes off decodePrincipal so the claims mapping
      // (roles/scope/userName) stays identical on every path, verified or legacy
      await verifyIdentity(resolverFor(authorityUrl), token, { issuer: authorityUrl });
      return decodePrincipal(token);
    } catch (err) {
      ctx.logger?.warn?.(`[identity] token verification failed: ${String(err)}`);
      return null;
    }
  }
}
