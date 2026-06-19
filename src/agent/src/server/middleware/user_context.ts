import type { Request, Response, NextFunction } from "express";
import { verifyIdentity } from "@agent-local/common";

// the principal that called this service. host -> agent is service-to-service, so the identity is the
// calling SERVICE, not an end user; the shape mirrors the Sandbox/console req.userContext so the wiring
// downstream (routes reading req.userContext) is unchanged whether or not enforcement is on.
export interface IRequestUserInfo {
  serviceId: string;
}

export interface IRequestUserContext {
  accessToken: string | null;
  userInfo: IRequestUserInfo | null;
  permissions: string[];
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userContext: IRequestUserContext;
    }
  }
}

function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, value] = header.split(" ");
  return scheme?.toLowerCase() === "bearer" && value ? value : null;
}

// resolves the caller from the bearer JWT, validated offline with the host's public key (getPublicKey).
// `authentication.required` gates enforcement: while false (the staged default) a missing/invalid token
// still resolves to the host stub principal so nothing breaks before the sender presents one; flipping it
// on rejects anything that fails verification. Reads req.serverConfig, so it runs after configContext.
export function userContextMiddleware(getPublicKey: () => Promise<string>) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const auth = req.serverConfig.authentication;
    const presented = bearerToken(req.headers.authorization);

    // authorityUrl present => validate as a host-issued RS256 JWT; issuer must match the authority
    if (presented && auth.authorityUrl) {
      try {
        const claims = await verifyIdentity(await getPublicKey(), presented, { issuer: auth.authorityUrl });
        req.userContext = {
          accessToken: presented,
          userInfo: { serviceId: claims.sub },
          permissions: claims.permissions,
        };
        next();
        return;
      } catch (err) {
        if (auth.required) {
          res.status(401).json({ error: "unauthorized" });
          return;
        }
        req.logger?.warn?.(`[agent-server] token verification failed, accepting as stub: ${String(err)}`);
      }
    } else if (auth.required) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    req.userContext = {
      accessToken: presented,
      userInfo: { serviceId: "host" },
      permissions: ["agent.invoke"],
    };
    next();
  };
}
