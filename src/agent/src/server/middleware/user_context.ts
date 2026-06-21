import type { Request, Response, NextFunction } from "express";
import { verifyIdentity, bearerToken, type JwtKeyResolver } from "@agent-local/common";
import { LOGGER, SERVER_CONFIG } from "../container-tokens.js";
import { SESSION_HEADER } from "./session-header.js";
import type { SessionRegistry } from "../session-registry.js";

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

// resolves the caller by one of three means, in order: a verified bearer JWT (must carry agent:trigger), else
// a live session id (its existence proves an authorized create minted it), else — only while
// `authentication.required` is false (staged) — the host stub. With required on, none-of-the-above is 401.
export function userContextMiddleware(getKey: JwtKeyResolver, sessions: SessionRegistry) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const auth = req.container.get(SERVER_CONFIG).authentication;
    const presented = bearerToken(req.headers.authorization);

    // authorityUrl present => validate as a host-issued RS256 JWT; issuer must match the authority
    if (presented && auth.authorityUrl) {
      try {
        const claims = await verifyIdentity(getKey, presented, { issuer: auth.authorityUrl });
        // a verified caller still needs the scope to talk to the agent at all; without it the token is valid
        // but unauthorized, so reject rather than fall through to the stub principal
        if (!claims.permissions.includes("agent:trigger")) {
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
        req.container.get(LOGGER).warn?.(`[agent-server] token verification failed: ${String(err)}`);
      }
    }

    // session-as-capability: a live session was minted by an authorized create, so its id authorizes follow-on calls (/events) without re-presenting a token
    const sessionId = req.header(SESSION_HEADER)?.trim();
    if (sessionId && sessions.get(sessionId)) {
      req.userContext = {
        accessToken: null,
        userInfo: { serviceId: sessionId },
        permissions: ["agent:trigger"],
      };
      next();
      return;
    }

    if (auth.required) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    req.userContext = {
      accessToken: presented,
      userInfo: { serviceId: "host" },
      permissions: ["agent:trigger"],
    };
    next();
  };
}
