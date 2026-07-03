import { randomBytes, createHash } from "node:crypto";
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
  type IdentityClaims,
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
const SERVICE_TOKEN_TTL_SECONDS = 15 * 60;

// a CLI login is a long-running background session, not a per-call service hop, so its bearer outlives one
const CLI_TOKEN_TTL = "12h";
const CLI_TOKEN_TTL_SECONDS = 12 * 60 * 60;

// client-credentials grant (RFC 6749 4.4): the Basic principal's own token, no subject involved
const CLIENT_CREDENTIALS_GRANT = "client_credentials";
// what a successful token exchange issues (RFC 8693 2.2.1): an access token, echoed as issued_token_type
const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";

// authorization_code grant (RFC 6749 4.1 + RFC 7636 PKCE), used by native/public clients (no client secret)
const AUTHORIZATION_CODE_GRANT = "authorization_code";
// a code is redeemed once, moments after mint (the browser round-trip); anything left over is abandoned, not reused
const AUTHORIZE_CODE_TTL_MS = 60_000;

interface PendingCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  claims: IdentityClaims;
  expiresAt: number;
}

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
  nativeClients: AuthSettings["nativeClients"] = {},
): Router {
  const router = Router();
  const users = new UserRegistry();
  // in-memory: codes are single-use and live ~60s, so a process restart losing them mid-flight just means the
  // user retries login — never worth a DB round-trip for a value this short-lived.
  const pendingCodes = new Map<string, PendingCode>();

  // redirect_uri can't be an exact-URL whitelist (the CLI mints a fresh ephemeral port every login). Instead
  // pin scheme=http, host=the loopback literal (127.0.0.1/::1 — NEVER the name "localhost", which a hostile
  // resolver can repoint) and an exact path per registered client_id; the port is the only free variable.
  function isAllowedRedirect(clientId: string, redirectUri: string): boolean {
    const client = nativeClients?.[clientId];
    if (!client) return false;
    let url: URL;
    try {
      url = new URL(redirectUri);
    } catch {
      return false;
    }
    const isLoopbackHost = url.hostname === "127.0.0.1" || url.hostname === "::1";
    return url.protocol === "http:" && isLoopbackHost && url.pathname === client.redirectPath;
  }

  function sweepExpiredCodes(): void {
    const now = Date.now();
    for (const [code, pending] of pendingCodes) {
      if (now >= pending.expiresAt) pendingCodes.delete(code);
    }
  }

  // mints a single-use code bound to this exact client/redirect/challenge and bounces the browser back to the
  // native client's loopback; shared by the credential POST and the returning-session fast path on GET
  function issueCodeRedirect(
    res: Response,
    q: { clientId: string; redirectUri: string; state: string; codeChallenge: string },
    claims: IdentityClaims,
  ): void {
    sweepExpiredCodes();
    const code = randomBytes(32).toString("base64url");
    pendingCodes.set(code, {
      clientId: q.clientId,
      redirectUri: q.redirectUri,
      codeChallenge: q.codeChallenge,
      claims,
      expiresAt: Date.now() + AUTHORIZE_CODE_TTL_MS,
    });
    logger.debug?.(`[auth] issued authorization code for ${claims.userName} (client=${q.clientId})`);
    const target = new URL(q.redirectUri);
    target.searchParams.set("code", code);
    target.searchParams.set("state", q.state);
    res.redirect(302, target.toString());
  }
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
    const identity = await users.verify(username ?? "", password ?? "");
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

  // renders the tiny self-hosted login form for a PKCE authorization_code request. Deliberately NOT a redirect
  // to the web app: this IdP owns its own login surface (same as any standalone authorization server), so a
  // native client (the CLI) never has to trust — or even know about — the web app's origin.
  function renderAuthorizeForm(params: Record<string, string>, error?: string): string {
    const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
    const hidden = Object.entries(params).map(([k, v]) => `<input type="hidden" name="${escape(k)}" value="${escape(v)}">`).join("\n");
    // inline styles only: this page is served by the IdP itself with no assets/CSP surface to maintain
    const rowStyle = "display:flex;align-items:center;gap:12px";
    const labelStyle = "width:80px;color:#333";
    const inputStyle = "flex:1;padding:6px 8px;border:1px solid #c8ccd4;border-radius:4px;font-size:14px";
    return `<!doctype html><html><body style="margin:0;min-height:100vh;display:flex;justify-content:center;align-items:flex-start;background:#f4f5f7;font-family:system-ui,-apple-system,sans-serif">
      <form method="post" action="/connect/authorize" style="margin-top:12vh;min-width:320px;padding:28px 32px;display:flex;flex-direction:column;gap:14px;background:#fff;border:1px solid #d9dce1;border-radius:8px">
        <h3 style="margin:0 0 4px">Sign in</h3>
        ${error ? `<p style="margin:0;color:#c0392b">${escape(error)}</p>` : ""}
        ${hidden}
        <div style="${rowStyle}"><label for="username" style="${labelStyle}">Username</label><input id="username" name="username" autofocus style="${inputStyle}"></div>
        <div style="${rowStyle}"><label for="password" style="${labelStyle}">Password</label><input id="password" name="password" type="password" style="${inputStyle}"></div>
        <button type="submit" style="padding:8px;border:0;border-radius:4px;background:#2d6cdf;color:#fff;font-size:14px;cursor:pointer">Sign in</button>
      </form>
    </body></html>`;
  }

  // GET renders the form; a bad client_id/redirect_uri is rejected with a plain 400 HERE rather than redirected
  // anywhere — an open redirect on this endpoint would let a malicious link bounce a victim's browser through
  // our IdP to an attacker-controlled origin, so an invalid target must be a dead end, never a hop.
  router.get("/connect/authorize", (req: Request, res: Response) => {
    const q = req.query as Record<string, string | undefined>;
    const { client_id, redirect_uri, state, code_challenge, code_challenge_method } = q;
    if (!client_id || !redirect_uri || !state || !code_challenge || code_challenge_method !== "S256") {
      res.status(400).send("invalid authorization request");
      return;
    }
    if (!isAllowedRedirect(client_id, redirect_uri)) {
      res.status(400).send("redirect_uri not allowed for this client_id");
      return;
    }
    // a live session ticket (the cross-subdomain cookie sealed at login) skips the form entirely: the IdP
    // reuses its own session like any SSO, so an already-signed-in browser bounces straight back with a code
    if (req.authTicket?.authenticated) {
      issueCodeRedirect(res, { clientId: client_id, redirectUri: redirect_uri, state, codeChallenge: code_challenge }, req.authTicket.claims);
      return;
    }
    res.type("html").send(renderAuthorizeForm({ client_id, redirect_uri, state, code_challenge }));
  });

  // POST re-validates the whitelist against the posted (not just the originally-rendered) values — the hidden
  // fields are round-tripped through the browser, so nothing in the request is trusted without re-checking.
  router.post("/connect/authorize", async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, string | undefined>;
    const { client_id, redirect_uri, state, code_challenge, username, password } = body;
    if (!client_id || !redirect_uri || !state || !code_challenge) {
      res.status(400).send("invalid authorization request");
      return;
    }
    if (!isAllowedRedirect(client_id, redirect_uri)) {
      res.status(400).send("redirect_uri not allowed for this client_id");
      return;
    }
    const identity = await users.verify(username ?? "", password ?? "");
    if (!identity) {
      res.type("html").status(401).send(
        renderAuthorizeForm({ client_id, redirect_uri, state, code_challenge }, "invalid credentials"),
      );
      return;
    }
    const claims: IdentityClaims = {
      sub: identity.userId,
      userName: identity.userName,
      firstName: identity.firstName,
      lastName: identity.lastName,
      permissions: identity.permissions,
    };
    // also seal the browser session (same ticket as /account/login) so the NEXT authorize takes the SSO path
    const accessToken = await signIdentity(signer.privatePem, claims, { ...jwtOptions, kid: await signerKidPromise });
    const ticket = await sealTicket({ accessToken, claims, authenticated: true }, cookieKey, SESSION_TTL);
    res.cookie(SESSION_COOKIE_NAME, ticket, { ...cookieOptions, maxAge: SESSION_TTL_MS });
    issueCodeRedirect(res, { clientId: client_id, redirectUri: redirect_uri, state, codeChallenge: code_challenge }, claims);
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
  // RFC 6749 5.1 success response; token-exchange adds issued_token_type (RFC 8693 2.2.1) via extra
  const sendToken = (res: Response, accessToken: string, expiresInSeconds: number, extra: Record<string, string> = {}): void => {
    res.json({ access_token: accessToken, token_type: "Bearer", expires_in: expiresInSeconds, ...extra });
  };
  // RFC 6749 5.2 error response: a registered `error` code, with the human detail under error_description
  const sendTokenError = (res: Response, status: number, error: string, description: string): void => {
    res.status(status).json({ error, error_description: description });
  };

  const issueServiceToken = async (req: Request, res: Response): Promise<void> => {
    const rawBody = (req.body ?? {}) as Record<string, string | undefined>;

    // PKCE authorization_code: a public client (no secret — the CLI ships none), so the code_verifier stands
    // in for Basic auth. The code is redeemed exactly once regardless of outcome, so a stolen/replayed code
    // dies on first use whether or not it succeeds.
    if (rawBody.grant_type === AUTHORIZATION_CODE_GRANT) {
      const { code, code_verifier, redirect_uri, client_id } = rawBody;
      if (!code || !code_verifier || !redirect_uri || !client_id) {
        sendTokenError(res, 400, "invalid_request", "missing code, code_verifier, redirect_uri, or client_id");
        return;
      }
      const pending = pendingCodes.get(code);
      pendingCodes.delete(code);
      if (!pending || Date.now() > pending.expiresAt) {
        sendTokenError(res, 400, "invalid_grant", "invalid or expired code");
        return;
      }
      // the code must be redeemed under the SAME client_id/redirect_uri it was minted for — binds it to one flow
      if (pending.clientId !== client_id || pending.redirectUri !== redirect_uri) {
        sendTokenError(res, 400, "invalid_grant", "client_id or redirect_uri mismatch");
        return;
      }
      const computedChallenge = createHash("sha256").update(code_verifier).digest("base64url");
      if (computedChallenge !== pending.codeChallenge) {
        sendTokenError(res, 400, "invalid_grant", "invalid code_verifier");
        return;
      }
      const token = await signIdentity(signer.privatePem, pending.claims, {
        ...jwtOptions,
        expiresIn: CLI_TOKEN_TTL,
        kid: await signerKidPromise,
      });
      logger.debug?.(`[auth] issued CLI token for ${pending.claims.userName} (client=${client_id})`);
      sendToken(res, token, CLI_TOKEN_TTL_SECONDS);
      return;
    }

    const creds = basicCredentials(req.headers.authorization);
    if (!creds) {
      // RFC 6749 5.2: a 401 for failed Authorization-header auth carries the challenge for the scheme used
      res.set("WWW-Authenticate", 'Basic realm="token"');
      sendTokenError(res, 401, "invalid_client", "missing basic credentials");
      return;
    }
    const actor = await users.verify(creds.username, creds.password);
    if (!actor) {
      res.set("WWW-Authenticate", 'Basic realm="token"');
      sendTokenError(res, 401, "invalid_client", "invalid credentials");
      return;
    }

    const { grant_type, subject_token } = rawBody;
    if (grant_type === TOKEN_EXCHANGE_GRANT) {
      if (!subject_token) {
        sendTokenError(res, 400, "invalid_request", "missing subject_token");
        return;
      }
      // verify the subject_token against the auth service's own keys; a bad/forged subject must not yield a delegated
      // token. the two permission sets stay separate: subject's at top level, actor's under `act` — never merged.
      let subject;
      try {
        subject = await verifyIdentity(subjectResolver, subject_token, jwtOptions);
      } catch (err) {
        logger.warn?.(`[auth] subject_token verification failed: ${String(err)}`);
        sendTokenError(res, 400, "invalid_grant", "invalid subject_token");
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
      sendToken(res, oboToken, SERVICE_TOKEN_TTL_SECONDS, { issued_token_type: ACCESS_TOKEN_TYPE });
      return;
    }

    if (grant_type !== CLIENT_CREDENTIALS_GRANT) {
      sendTokenError(res, 400, "unsupported_grant_type", `unsupported grant_type "${grant_type ?? ""}"`);
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
    sendToken(res, token, SERVICE_TOKEN_TTL_SECONDS);
  };
  // /connect/token is the standard, discovery-advertised token endpoint: client-credentials + token-exchange
  router.post("/connect/token", issueServiceToken);

  // standard JWKS: consumers point jose's createRemoteJWKSet (or any JWKS client) here to verify host JWTs.
  // publishes the whole ring so a consumer can verify tokens signed by either the active or the retiring key.
  const sendJwks = async (_req: Request, res: Response): Promise<void> => {
    res.json({ keys: await jwksPromise });
  };
  // /.well-known/jwks.json is the conventional standalone JWKS path, advertised as jwks_uri — the sole one
  router.get("/.well-known/jwks.json", sendJwks);

  // OIDC discovery document: one URL a standard client reads to find the issuer, signing keys, and token
  // endpoint. fields are honest to what this server does — client-credentials, token-exchange, and PKCE
  // authorization_code (public clients authenticate with "none"), all RS256.
  router.get("/.well-known/openid-configuration", (req: Request, res: Response) => {
    const origin = originFor(req);
    res.json({
      issuer: origin,
      jwks_uri: `${origin}/.well-known/jwks.json`,
      authorization_endpoint: `${origin}/connect/authorize`,
      token_endpoint: `${origin}/connect/token`,
      token_endpoint_auth_methods_supported: ["client_secret_basic", "none"],
      grant_types_supported: [CLIENT_CREDENTIALS_GRANT, TOKEN_EXCHANGE_GRANT, AUTHORIZATION_CODE_GRANT],
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
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
