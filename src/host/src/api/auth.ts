import { Router, type Request, type Response } from "express";
import {
  signIdentity,
  publicJwk,
  verifyIdentity,
  createLocalKeyResolver,
  cookieValue,
  SESSION_COOKIE_NAME,
  type ILogger,
  type HostSettings,
} from "@agent-local/common";
import { UserRegistry, ACCESS_TOKEN_PERMISSION } from "../user/userRegistry.js";
import type { KeyRing } from "../user/keys.js";

// the host owns IAM, so it owns the issuer: /api/login authenticates against the local UserRegistry and
// mints an RS256 JWT; /.well-known/jwks.json publishes the verify keys as a standard JWKS so any dependency
// can consume tokens with an off-the-shelf JWKS client.
export function createAuthApi(keys: KeyRing, iam: HostSettings["iam"], logger: ILogger): Router {
  const router = Router();
  const users = new UserRegistry();
  const jwtOptions = { issuer: iam?.issuerUrl || undefined, audience: iam?.audience || undefined };
  // the active signer is the head of the ring; the whole ring is published as JWKs so a rotation (new head,
  // old key demoted) keeps verifying in-flight tokens. each token carries the kid of the key that signed it.
  const signer = keys[0];
  const jwksPromise = Promise.all(keys.map((k) => publicJwk(k.publicPem)));
  const signerKidPromise = jwksPromise.then((jwks) => jwks[0].kid);

  router.post("/api/login", async (req: Request, res: Response) => {
    const { username, password } = (req.body ?? {}) as { username?: string; password?: string };
    const identity = users.verify(username ?? "", password ?? "");
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
      { ...jwtOptions, kid: await signerKidPromise },
    );
    // session lives in an httpOnly cookie so the browser carries it on the host's own routes without JS
    // touching it; sameSite=lax + path=/ keeps it scoped to same-site navigations. maxAge mirrors the 8h JWT.
    res.cookie(SESSION_COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 8 * 60 * 60 * 1000,
    });
    logger.debug?.(`[host] issued JWT for ${identity.userName}`);
    res.json({ token, user: identity });
  });

  // standard JWKS: consumers point jose's createRemoteJWKSet (or any JWKS client) here to verify host JWTs.
  // publishes the whole ring so a consumer can verify tokens signed by either the active or the retiring key.
  router.get("/.well-known/jwks.json", async (_req: Request, res: Response) => {
    res.json({ keys: await jwksPromise });
  });

  // privileged readback of the caller's own session access key: the host reads the session cookie, verifies it
  // against its own public key (no JWKS round-trip — it signed the token) and returns it only to holders of
  // ACCESS_TOKEN_PERMISSION, so the access key is never echoed back to an ordinary session.
  const getKey = createLocalKeyResolver(keys.map((k) => k.publicPem));
  router.get("/api/auth/accesstoken", async (req: Request, res: Response) => {
    const presented = cookieValue(req.headers.cookie, SESSION_COOKIE_NAME);
    if (!presented) {
      res.status(401).json({ error: "no session" });
      return;
    }
    try {
      const claims = await verifyIdentity(getKey, presented, jwtOptions);
      if (!claims.permissions.includes(ACCESS_TOKEN_PERMISSION)) {
        res.status(403).json({ error: "forbidden" });
        return;
      }
      logger.debug?.(`[host] returned session access key to ${claims.userName}`);
      res.json({ accessToken: presented });
    } catch {
      res.status(401).json({ error: "invalid token" });
    }
  });

  return router;
}
