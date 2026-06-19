import { URL } from "node:url";
import {
  SignJWT,
  jwtVerify,
  importPKCS8,
  importSPKI,
  exportJWK,
  calculateJwkThumbprint,
  createRemoteJWKSet,
  type JWK,
  type JWTVerifyGetKey,
} from "jose";

// RS256 so the holder of the private key (the host) signs and any dependency holding only the PUBLIC key
// can verify without a shared secret — that asymmetry is the whole point of moving the public key around.
const ALG = "RS256";

// resolves the verify key for a token from its header (its kid); jose's jwtVerify consumes one of these.
// aliased so the standard JWKS resolver type stays an implementation detail of this module, not the callers.
export type JwtKeyResolver = JWTVerifyGetKey;

// the identity the host puts inside the token and every consumer reads back out; mirrors the web's
// IRequestUserInfo so the verify side can attach it to a request context unchanged.
export interface IdentityClaims {
  sub: string;
  userName: string;
  firstName: string;
  lastName: string;
  permissions: string[];
}

// permission a principal must carry to call the agent at all (enforced in the agent's userContext middleware):
// the host grants it so the issued token — the web's session cookie — carries the scope down to the agent.
export const AGENT_INVOKE_PERMISSION = "agent.invoke";

// permission a principal must carry to start a unit of work on the agent (gates POST /session/create):
// the host grants it in the user registry and stamps it into the JWT; the agent enforces it on the token.
export const EXECUTE_WORK_PERMISSION = "executework";

export interface JwtOptions {
  issuer?: string;
  audience?: string;
  // token lifetime as a jose time string; short by default since these are local operator sessions
  expiresIn?: string;
  // key id stamped into the JWT header so a JWKS consumer selects the matching key; omitted when absent
  kid?: string;
}

// signs identity claims with the PKCS8 private PEM; the host is the only party that ever calls this
export async function signIdentity(
  privatePem: string,
  claims: IdentityClaims,
  options: JwtOptions = {},
): Promise<string> {
  const key = await importPKCS8(privatePem, ALG);
  let jwt = new SignJWT({
    userName: claims.userName,
    firstName: claims.firstName,
    lastName: claims.lastName,
    permissions: claims.permissions,
  })
    .setProtectedHeader(options.kid ? { alg: ALG, kid: options.kid } : { alg: ALG })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(options.expiresIn ?? "8h");
  if (options.issuer) jwt = jwt.setIssuer(options.issuer);
  if (options.audience) jwt = jwt.setAudience(options.audience);
  return jwt.sign(key);
}

// the public half as a JWK with a stable kid (RFC 7638 thumbprint): the host publishes it in its JWKS and
// stamps the same kid on every token it signs, so a consumer matches the two. use/alg pin it to RS256 verify.
export async function publicJwk(publicPem: string): Promise<JWK> {
  const key = await importSPKI(publicPem, ALG);
  const jwk = await exportJWK(key);
  const kid = await calculateJwkThumbprint(jwk);
  return { ...jwk, kid, use: "sig", alg: ALG };
}

// the standard remote-JWKS resolver: fetches + memoizes the key set at jwksUrl and selects the key by the
// token's kid, refetching on an unknown kid so a signing-key rotation is picked up without a restart.
export function createJwksResolver(jwksUrl: string): JwtKeyResolver {
  return createRemoteJWKSet(new URL(jwksUrl));
}

// resolver for verifying tokens against public keys already in hand (the host verifying what it itself
// signed): no JWKS round-trip since issuer and verifier are the same process. Takes the whole key ring and
// selects by the token's kid, so tokens minted under a now-retired signing key still verify mid-rotation.
export function createLocalKeyResolver(publicPems: string[]): JwtKeyResolver {
  let ringPromise: Promise<Map<string, Awaited<ReturnType<typeof importSPKI>>>> | null = null;
  const build = async (): Promise<Map<string, Awaited<ReturnType<typeof importSPKI>>>> => {
    const byKid = new Map<string, Awaited<ReturnType<typeof importSPKI>>>();
    for (const pem of publicPems) {
      const { kid } = await publicJwk(pem);
      byKid.set(String(kid), await importSPKI(pem, ALG));
    }
    return byKid;
  };
  return async (header) => {
    if (!ringPromise) ringPromise = build();
    const byKid = await ringPromise;
    const key = (header?.kid ? byKid.get(header.kid) : undefined) ?? byKid.values().next().value;
    if (!key) throw new Error("no local verify key for kid");
    return key;
  };
}

// extracts the token from an `Authorization: Bearer <token>` header; null when absent or not a bearer scheme
export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, value] = header.split(" ");
  return scheme?.toLowerCase() === "bearer" && value ? value : null;
}

// name of the cookie the host sets at login and reads back on its own routes; mirrors the web's TOKEN_KEY so
// the browser session and the server agree on one identifier
export const SESSION_COOKIE_NAME = "agent.local.jwt";

// reads a named cookie from a raw Cookie header; null when absent. parses by hand so the host needs no
// cookie-parser dependency for the single session cookie it carries.
export function cookieValue(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

// verifies a token against a key resolver (a JWKS) and returns the identity; this is the "consume" side any
// dependency runs against the host's JWKS. Throws (jose) when signature/claims fail or no key matches.
export async function verifyIdentity(
  getKey: JwtKeyResolver,
  token: string,
  options: JwtOptions = {},
): Promise<IdentityClaims> {
  const { payload } = await jwtVerify(token, getKey, {
    issuer: options.issuer,
    audience: options.audience,
  });
  return {
    sub: String(payload.sub),
    userName: String(payload.userName ?? ""),
    firstName: String(payload.firstName ?? ""),
    lastName: String(payload.lastName ?? ""),
    permissions: Array.isArray(payload.permissions) ? (payload.permissions as string[]) : [],
  };
}
