import { Router, type Request, type Response } from "express";
import { signIdentity, type ILogger, type HostSettings } from "@agent-local/common";
import { UserRegistry } from "../user/userRegistry.js";
import type { KeyPair } from "../user/keys.js";

// the host owns IAM, so it owns the issuer: /api/login authenticates against the local UserRegistry and
// mints an RS256 JWT; /api/auth/public-key publishes the verify half so any dependency can consume tokens.
export function createAuthApi(keys: KeyPair, iam: HostSettings["iam"], logger: ILogger): Router {
  const router = Router();
  const users = new UserRegistry();
  const jwtOptions = { issuer: iam?.issuerUrl || undefined, audience: iam?.audience || undefined };

  router.post("/api/login", async (req: Request, res: Response) => {
    const { username, password } = (req.body ?? {}) as { username?: string; password?: string };
    const identity = users.verify(username ?? "", password ?? "");
    if (!identity) {
      res.status(401).json({ error: "invalid credentials" });
      return;
    }
    const token = await signIdentity(
      keys.privatePem,
      {
        sub: identity.userId,
        userName: identity.userName,
        firstName: identity.firstName,
        lastName: identity.lastName,
        permissions: identity.permissions,
      },
      jwtOptions,
    );
    logger.debug?.(`[host] issued JWT for ${identity.userName}`);
    res.json({ token, user: identity });
  });

  // PEM, not JSON — consumers feed it straight into verifyIdentity / jose importSPKI
  router.get("/api/auth/public-key", (_req: Request, res: Response) => {
    res.type("text/plain").send(keys.publicPem);
  });

  return router;
}
