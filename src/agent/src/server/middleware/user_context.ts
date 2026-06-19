import type { Request, Response, NextFunction } from "express";
import { verifyIdentity, bearerToken, AGENT_INVOKE_PERMISSION, type JwtKeyResolver } from "@agent-local/common";

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

// resolves the caller from the bearer JWT, validated against the host's JWKS (getKey selects the key by kid).
// `authentication.required` gates enforcement: while false (the staged default) a missing/invalid token
// still resolves to the host stub principal so nothing breaks before the sender presents one; flipping it
// on rejects anything that fails verification. Reads req.serverConfig, so it runs after configContext.
export function userContextMiddleware(getKey: JwtKeyResolver) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const auth = req.serverConfig.authentication;
    const presented = bearerToken(req.headers.authorization);

    // authorityUrl present => validate as a host-issued RS256 JWT; issuer must match the authority
    if (presented && auth.authorityUrl) {
      try {
        const claims = await verifyIdentity(getKey, presented, { issuer: auth.authorityUrl });
        // a verified caller still needs the scope to talk to the agent at all; without it the token is valid
        // but unauthorized, so reject rather than fall through to the stub principal
        if (!claims.permissions.includes(AGENT_INVOKE_PERMISSION)) {
          res.status(403).json({ error: "forbidden" });
          return;
        }
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
      permissions: [AGENT_INVOKE_PERMISSION],
    };
    next();
  };
}
