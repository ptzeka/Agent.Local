import { Router, type Request, type Response } from "express";
import {
  signIdentity,
  verifyIdentity,
  createLocalKeyResolver,
  TOKEN_EXCHANGE_GRANT,
  publicJwk,
  sealTicket,
  basicCredentials,
  SESSION_COOKIE_NAME,
  type ILogger,
} from "@agent-local/common";
import { UserRegistry } from "./userRegistry.js";
import type { KeyRing } from "./keys.js";
import type { AuthSettings } from "./appsettings.js";

// session lifetime: both the RS256 access token and the encrypted cookie ticket expire after this, so the
// browser session and the agent-facing bearer go stale together.
const SESSION_TTL = "2h";
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;

// service tokens (client-credentials) are short-lived: the agent fetches one per call and discards it
const SERVICE_TOKEN_TTL = "15m";

// the auth service owns IAM: /account/login authenticates against the local UserRegistry, mints an RS256 access
// token, and returns it ONLY inside an encrypted httpOnly cookie ticket (cookieKey seals it — "encrypt at
// response"); /.well-known/openid-configuration advertises the issuer + jwks + token endpoints so any standard
// OIDC/OAuth client (jose's createRemoteJWKSet, Temporal's JWT authorizer) self-configures from one discovery URL.
export function createAuthApi(
  keys: KeyRing,
  iam: AuthSettings["iam"],
  cookieKey: Uint8Array,
  logger: ILogger,
  cookieDomain?: string,
): Router {
  const router = Router();
  const users = new UserRegistry();
  // shared cookie attributes for set and clear: they MUST match (domain/path/sameSite) or the browser keeps a
  // stale cookie clearCookie can't target. domain widens it to a parent so the host reads it cross-subdomain.
  const cookieOptions = { httpOnly: true as const, sameSite: "lax" as const, path: "/", ...(cookieDomain ? { domain: cookieDomain } : {}) };
  const jwtOptions = { issuer: iam?.issuerUrl || undefined, audience: iam?.audience || undefined, expiresIn: SESSION_TTL };
  // the active signer is the head of the ring; the whole ring is published as JWKs so a rotation (new head,
  // old key demoted) keeps verifying in-flight tokens. each token carries the kid of the key that signed it.
  const signer = keys[0];
  const jwksPromise = Promise.all(keys.map((k) => publicJwk(k.publicPem)));
  const signerKidPromise = jwksPromise.then((jwks) => jwks[0].kid);
  // verify subject tokens against the whole ring (issuer verifying what it itself signed); reused across exchanges
  const subjectResolver = createLocalKeyResolver(keys.map((k) => k.publicPem));

  // base origin for the discovery URLs: the configured issuer when set (so discovery's issuer matches the `iss`
  // verifiers check), else the request's own origin so local dev works before issuerUrl is configured.
  const configuredIssuer = (iam?.issuerUrl || "").replace(/\/$/, "");
  const originFor = (req: Request) => configuredIssuer || `${req.protocol}://${req.get("host")}`;

  router.post("/account/login", async (req: Request, res: Response) => {
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
    res.cookie(SESSION_COOKIE_NAME, ticket, { ...cookieOptions, maxAge: SESSION_TTL_MS });
    logger.debug?.(`[auth] issued session for ${identity.userName}`);
    res.json({ user: identity });
  });

  // ends the session: clear the cookie so the next request opens no ticket and renders unauthenticated
  router.post("/account/logout", (_req: Request, res: Response) => {
    res.clearCookie(SESSION_COOKIE_NAME, cookieOptions);
    res.json({ ok: true });
  });

  // "who am I": returns the current session's identity from the decrypted ticket (sessionMiddleware), so the
  // browser reads its own claims without the access token ever leaving httpOnly. 401 when no/expired session.
  router.get("/account/me", (req: Request, res: Response) => {
    const ticket = req.authTicket;
    if (!ticket?.authenticated) {
      res.status(401).json({ error: "no session" });
      return;
    }
    const { sub, userName, firstName, lastName, permissions } = ticket.claims;
    res.json({ sub, userName, firstName, lastName, permissions });
  });

  // /connect/token: a service presents HTTP Basic clientId:secret and gets a short-lived RS256 bearer. Two grants
  // share the endpoint — plain client-credentials (the token carries the service's OWN claims) and RFC 8693 token
  // exchange (a subject_token yields an OBO token whose top-level claims are the SUBJECT's and whose `act` names
  // the service). The Basic principal authenticates the caller and IS the actor in the exchange case.
  const issueServiceToken = async (req: Request, res: Response): Promise<void> => {
    const creds = basicCredentials(req.headers.authorization);
    if (!creds) {
      res.status(401).json({ error: "missing basic credentials" });
      return;
    }
    const actor = users.verify(creds.username, creds.password);
    if (!actor) {
      res.status(401).json({ error: "invalid credentials" });
      return;
    }

    const { grant_type, subject_token } = (req.body ?? {}) as { grant_type?: string; subject_token?: string };
    if (grant_type === TOKEN_EXCHANGE_GRANT && subject_token) {
      // verify the subject_token against the auth service's own keys; a bad/forged subject must not yield a delegated
      // token. the two permission sets stay separate: subject's at top level, actor's under `act` — never merged.
      let subject;
      try {
        subject = await verifyIdentity(subjectResolver, subject_token, jwtOptions);
      } catch (err) {
        logger.warn?.(`[auth] subject_token verification failed: ${String(err)}`);
        res.status(400).json({ error: "invalid subject_token" });
        return;
      }
      const oboToken = await signIdentity(
        signer.privatePem,
        {
          sub: subject.sub,
          userName: subject.userName,
          firstName: subject.firstName,
          lastName: subject.lastName,
          permissions: subject.permissions,
          act: { sub: actor.userId, permissions: actor.permissions },
        },
        { ...jwtOptions, expiresIn: SERVICE_TOKEN_TTL, kid: await signerKidPromise },
      );
      logger.debug?.(`[auth] issued OBO token sub=${subject.userName} act=${actor.userName}`);
      res.json({ token: oboToken });
      return;
    }

    const token = await signIdentity(
      signer.privatePem,
      {
        sub: actor.userId,
        userName: actor.userName,
        firstName: actor.firstName,
        lastName: actor.lastName,
        permissions: actor.permissions,
      },
      { ...jwtOptions, expiresIn: SERVICE_TOKEN_TTL, kid: await signerKidPromise },
    );
    logger.debug?.(`[auth] issued service token for ${actor.userName}`);
    res.json({ token });
  };
  // /connect/token is the standard, discovery-advertised token endpoint: client-credentials + token-exchange
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
      grant_types_supported: ["client_credentials", TOKEN_EXCHANGE_GRANT],
      id_token_signing_alg_values_supported: ["RS256"],
      subject_types_supported: ["public"],
      claims_supported: ["sub", "userName", "firstName", "lastName", "permissions"],
    });
  });

  // privileged readback of the caller's own access token from the session ticket (already decrypted by
  // sessionMiddleware). Gated by the auth.accesstoken permission so the bearer is never echoed back to an ordinary
  // session; returns it for callers that must present it to the agent directly.
  router.get("/account/accesstoken", (req: Request, res: Response) => {
    const ticket = req.authTicket;
    if (!ticket?.authenticated) {
      res.status(401).json({ error: "no session" });
      return;
    }
    if (!ticket.claims.permissions.includes("auth.accesstoken")) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    logger.debug?.(`[auth] returned session access token to ${ticket.claims.userName}`);
    res.json({ accessToken: ticket.accessToken });
  });

  return router;
}
