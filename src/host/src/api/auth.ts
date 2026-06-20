import { Router, type Request, type Response } from "express";
import {
  signIdentity,
  publicJwk,
  sealTicket,
  basicCredentials,
  SESSION_COOKIE_NAME,
  type ILogger,
  type HostSettings,
} from "@agent-local/common";
import { UserRegistry } from "../user/userRegistry.js";
import type { KeyRing } from "../user/keys.js";

// session lifetime: both the RS256 access token and the encrypted cookie ticket expire after this, so the
// browser session and the agent-facing bearer go stale together.
const SESSION_TTL = "2h";
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;

// service tokens (client-credentials) are short-lived: the agent fetches one per call and discards it
const SERVICE_TOKEN_TTL = "15m";

// the host owns IAM: /api/login authenticates against the local UserRegistry, mints an RS256 access token, and
// returns it ONLY inside an encrypted httpOnly cookie ticket (cookieKey seals it — "encrypt at response");
// /.well-known/openid-configuration advertises the issuer + jwks + token endpoints so any standard OIDC/OAuth
// client (jose's createRemoteJWKSet, Temporal's JWT authorizer) self-configures from one discovery URL.
export function createAuthApi(keys: KeyRing, iam: HostSettings["iam"], cookieKey: Uint8Array, logger: ILogger): Router {
  const router = Router();
  const users = new UserRegistry();
  const jwtOptions = { issuer: iam?.issuerUrl || undefined, audience: iam?.audience || undefined, expiresIn: SESSION_TTL };
  // the active signer is the head of the ring; the whole ring is published as JWKs so a rotation (new head,
  // old key demoted) keeps verifying in-flight tokens. each token carries the kid of the key that signed it.
  const signer = keys[0];
  const jwksPromise = Promise.all(keys.map((k) => publicJwk(k.publicPem)));
  const signerKidPromise = jwksPromise.then((jwks) => jwks[0].kid);

  // base origin for the discovery URLs: the configured issuer when set (so discovery's issuer matches the `iss`
  // verifiers check), else the request's own origin so local dev works before issuerUrl is configured.
  const configuredIssuer = (iam?.issuerUrl || "").replace(/\/$/, "");
  const originFor = (req: Request) => configuredIssuer || `${req.protocol}://${req.get("host")}`;

  router.post("/api/login", async (req: Request, res: Response) => {
    const { username, password } = (req.body ?? {}) as { username?: string; password?: string };
    const identity = users.verify(username ?? "", password ?? "");
    if (!identity) {
      res.status(401).json({ error: "invalid credentials" });
      return;
    }
    const claims = {
      sub: identity.userId,
      userName: identity.userName,
      firstName: identity.firstName,
      lastName: identity.lastName,
      permissions: identity.permissions,
    };
    const accessToken = await signIdentity(signer.privatePem, claims, { ...jwtOptions, kid: await signerKidPromise });
    // the cookie is the encrypted authentication ticket (access token + claims + auth status), opaque to the
    // browser; httpOnly keeps JS out of it, sameSite=lax + path=/ scope it to same-site navigations, and maxAge
    // mirrors the ticket's own exp so the browser drops it exactly when the host would reject it anyway.
    const ticket = await sealTicket({ accessToken, claims, authenticated: true }, cookieKey, SESSION_TTL);
    res.cookie(SESSION_COOKIE_NAME, ticket, { httpOnly: true, sameSite: "lax", path: "/", maxAge: SESSION_TTL_MS });
    logger.debug?.(`[host] issued session for ${identity.userName}`);
    res.json({ user: identity });
  });

  // ends the session: clear the cookie so the next request opens no ticket and renders unauthenticated
  router.post("/api/logout", (_req: Request, res: Response) => {
    res.clearCookie(SESSION_COOKIE_NAME, { httpOnly: true, sameSite: "lax", path: "/" });
    res.json({ ok: true });
  });

  // "who am I": returns the current session's identity from the decrypted ticket (sessionMiddleware), so the
  // browser reads its own claims without the access token ever leaving httpOnly. 401 when no/expired session.
  router.get("/api/me", (req: Request, res: Response) => {
    const ticket = req.authTicket;
    if (!ticket?.authenticated) {
      res.status(401).json({ error: "no session" });
      return;
    }
    const { sub, userName, firstName, lastName, permissions } = ticket.claims;
    res.json({ sub, userName, firstName, lastName, permissions });
  });

  // client-credentials grant: a service (the agent) presents HTTP Basic clientId:secret and gets a short-lived
  // RS256 JWT carrying that user's claims — no cookie, no scope negotiation; the agent sends it as a bearer.
  const issueServiceToken = async (req: Request, res: Response): Promise<void> => {
    const creds = basicCredentials(req.headers.authorization);
    if (!creds) {
      res.status(401).json({ error: "missing basic credentials" });
      return;
    }
    const identity = users.verify(creds.username, creds.password);
    if (!identity) {
      res.status(401).json({ error: "invalid credentials" });
      return;
    }
    const token = await signIdentity(
      signer.privatePem,
      {
        sub: identity.userId,
        userName: identity.userName,
        firstName: identity.firstName,
        lastName: identity.lastName,
        permissions: identity.permissions,
      },
      { ...jwtOptions, expiresIn: SERVICE_TOKEN_TTL, kid: await signerKidPromise },
    );
    logger.debug?.(`[host] issued service token for ${identity.userName}`);
    res.json({ token });
  };
  // /connect/token is the standard, discovery-advertised token endpoint — the sole client-credentials path
  router.post("/connect/token", issueServiceToken);

  // standard JWKS: consumers point jose's createRemoteJWKSet (or any JWKS client) here to verify host JWTs.
  // publishes the whole ring so a consumer can verify tokens signed by either the active or the retiring key.
  const sendJwks = async (_req: Request, res: Response): Promise<void> => {
    res.json({ keys: await jwksPromise });
  };
  // /.well-known/openid-configuration/jwks is the standard, discovery-advertised JWKS path — the sole one
  router.get("/.well-known/openid-configuration/jwks", sendJwks);

  // OIDC discovery document: one URL a standard client reads to find the issuer, signing keys, and token
  // endpoint. fields are honest to what this server does — client-credentials only, RS256, no auth-code flow.
  router.get("/.well-known/openid-configuration", (req: Request, res: Response) => {
    const origin = originFor(req);
    res.json({
      issuer: origin,
      jwks_uri: `${origin}/.well-known/openid-configuration/jwks`,
      token_endpoint: `${origin}/connect/token`,
      token_endpoint_auth_methods_supported: ["client_secret_basic"],
      grant_types_supported: ["client_credentials"],
      id_token_signing_alg_values_supported: ["RS256"],
      subject_types_supported: ["public"],
      claims_supported: ["sub", "userName", "firstName", "lastName", "permissions"],
    });
  });

  // privileged readback of the caller's own access token from the session ticket (already decrypted by
  // sessionMiddleware). Gated by ACCESS_TOKEN_PERMISSION so the bearer is never echoed back to an ordinary
  // session; returns it for callers that must present it to the agent directly.
  router.get("/connect/accesstoken", (req: Request, res: Response) => {
    const ticket = req.authTicket;
    if (!ticket?.authenticated) {
      res.status(401).json({ error: "no session" });
      return;
    }
    if (!ticket.claims.permissions.includes("auth.accesstoken")) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    logger.debug?.(`[host] returned session access token to ${ticket.claims.userName}`);
    res.json({ accessToken: ticket.accessToken });
  });

  return router;
}
