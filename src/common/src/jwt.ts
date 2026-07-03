import { URL } from "node:url";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  SignJWT,
  jwtVerify,
  EncryptJWT,
  jwtDecrypt,
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

// the actor in an OBO (RFC 8693) token: the service acting on the subject's behalf, carried as the nested
// `act` claim so the subject's own permissions stay top-level and the two sets are never flattened together.
export interface ActorClaim {
  sub: string;
  permissions: string[];
}

// the identity the host puts inside the token and every consumer reads back out; mirrors the web's
// IRequestUserInfo so the verify side can attach it to a request context unchanged.
export interface IdentityClaims {
  sub: string;
  userName: string;
  firstName: string;
  lastName: string;
  permissions: string[];
  // present only on an exchanged OBO token: names the service acting for the subject (top-level claims stay the subject's)
  act?: ActorClaim;
}

// ---------------------------------------------------------------------------
// Session ticket (encrypted cookie)
// ---------------------------------------------------------------------------

// the host's authentication ticket: what the session cookie carries, ENCRYPTED (never readable by the
// browser). It bundles the agent access token (the RS256 JWT, forwarded as bearer), the identity claims the
// host hydrates request context from without re-verifying, and the auth status — mirroring an ASP.NET ticket.
export interface AuthTicket {
  accessToken: string;
  claims: IdentityClaims;
  authenticated: boolean;
}

// A256GCM with a `dir` (direct) symmetric key: the host both seals and opens the ticket, so a shared 256-bit
// key is the right tool — no asymmetry needed, and AEAD makes the cookie tamper-evident as well as opaque.
const TICKET_ENC = "A256GCM";

// derives the 32-byte A256GCM key from the configured secret by SHA-256, so any appsettings string (a
// passphrase now, a real secret later) yields a valid key without the operator hand-formatting 32 raw bytes.
export function sessionKey(secret: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(secret, "utf8").digest());
}

// encrypts the ticket into the compact JWE that becomes the cookie value (the "encrypt at response" half).
// exp lives inside the encrypted token so a tampered/forged cookie can't extend the session past expiresIn.
export async function sealTicket(ticket: AuthTicket, key: Uint8Array, expiresIn = "2h"): Promise<string> {
  return new EncryptJWT({ act: ticket.accessToken, claims: ticket.claims, authenticated: ticket.authenticated })
    .setProtectedHeader({ alg: "dir", enc: TICKET_ENC })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .encrypt(key);
}

// decrypts + validates the cookie back into a ticket (the "decrypt at middleware" half); returns null on a
// missing, tampered, or EXPIRED cookie so callers treat any of those uniformly as "not authenticated".
export async function openTicket(sealed: string | null | undefined, key: Uint8Array): Promise<AuthTicket | null> {
  if (!sealed) return null;
  try {
    const { payload } = await jwtDecrypt(sealed, key);
    const claims = (payload.claims ?? {}) as IdentityClaims;
    return {
      accessToken: String(payload.act ?? ""),
      claims: {
        sub: String(claims.sub ?? payload.sub ?? ""),
        userName: String(claims.userName ?? ""),
        firstName: String(claims.firstName ?? ""),
        lastName: String(claims.lastName ?? ""),
        permissions: Array.isArray(claims.permissions) ? claims.permissions : [],
      },
      authenticated: payload.authenticated === true,
    };
  } catch {
    return null;
  }
}

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
    ...(claims.act ? { act: claims.act } : {}),
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

// the conventional standalone JWKS location under an authority origin — the same URL discovery advertises,
// derived in ONE place so every verifier and the publisher agree on the path.
export function jwksUrlFor(authorityUrl: string): string {
  return `${authorityUrl.replace(/\/$/, "")}/.well-known/jwks.json`;
}

// remote-JWKS resolver for an authority, deferring construction (and the URL parse) to the first token that
// needs verifying — when authorityUrl is unset no token is ever validated, so an empty URL must not throw at
// startup. logPrefix names the consuming service in the one debug line ("[host]", "[agent-server]").
export function createLazyJwksProvider(
  authorityUrl: string,
  logPrefix: string,
  debug?: (message: string) => void,
): JwtKeyResolver {
  let resolver: JwtKeyResolver | null = null;
  return (protectedHeader, token) => {
    if (!resolver) {
      const url = jwksUrlFor(authorityUrl);
      resolver = createJwksResolver(url);
      debug?.(`${logPrefix} verifying JWTs against JWKS at ${url}`);
    }
    return resolver(protectedHeader, token);
  };
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

// decodes an `Authorization: Basic <base64(user:pass)>` header into credentials; null when absent or malformed.
// split on the FIRST colon only, so a password may itself contain colons without being truncated.
export function basicCredentials(header: string | undefined): { username: string; password: string } | null {
  if (!header) return null;
  const [scheme, value] = header.split(" ");
  if (scheme?.toLowerCase() !== "basic" || !value) return null;
  const decoded = Buffer.from(value, "base64").toString("utf8");
  const sep = decoded.indexOf(":");
  if (sep === -1) return null;
  return { username: decoded.slice(0, sep), password: decoded.slice(sep + 1) };
}

// builds an `Authorization: Basic` header value from client credentials; the agent uses it to fetch a token
export function basicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
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
  const actor = payload.act as { sub?: unknown; permissions?: unknown } | undefined;
  return {
    sub: String(payload.sub),
    userName: String(payload.userName ?? ""),
    firstName: String(payload.firstName ?? ""),
    lastName: String(payload.lastName ?? ""),
    permissions: Array.isArray(payload.permissions) ? (payload.permissions as string[]) : [],
    ...(actor && actor.sub
      ? { act: { sub: String(actor.sub), permissions: Array.isArray(actor.permissions) ? (actor.permissions as string[]) : [] } }
      : {}),
  };
}
