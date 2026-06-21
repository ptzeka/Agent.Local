import { createJwksResolver, type ILogger, type JwtKeyResolver } from "@agent-local/common";

// builds the standard remote-JWKS resolver for the auth authority, deferring construction (and the URL parse)
// to the first token that needs verifying — when authorityUrl is unset no token is ever validated, so an
// empty URL must not throw at startup. jose's set then memoizes the fetch and refetches on an unknown kid.
export function createJwksProvider(authorityUrl: string, logger: ILogger): JwtKeyResolver {
  let resolver: JwtKeyResolver | null = null;
  return (protectedHeader, token) => {
    if (!resolver) {
      const url = `${authorityUrl.replace(/\/$/, "")}/.well-known/openid-configuration/jwks`;
      resolver = createJwksResolver(url);
      logger.debug?.(`[host] verifying JWTs against JWKS at ${url}`);
    }
    return resolver(protectedHeader, token);
  };
}
