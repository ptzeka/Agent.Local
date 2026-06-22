import type { Request, Response, NextFunction } from "express";
import { verifyIdentity, bearerToken, type JwtKeyResolver } from "@agent-local/common";
import { LOGGER, SERVER_CONFIG } from "../container-tokens.js";
import { SESSION_HEADER } from "./session-header.js";
import type { SessionRegistry } from "../session-registry.js";

// the principal that called this service. host -> agent is service-to-service, so the actor is always the
// calling SERVICE (serviceId). On an OBO (RFC 8693) call the service is acting FOR a user, whose verified
// identity rides the token's subject and is surfaced as userId; userId is undefined for a plain service token
// (a job). The shape mirrors the Sandbox/console req.userContext so downstream wiring is unchanged.
export interface IRequestUserInfo {
  serviceId: string;
  // the end user the call is on behalf of, from the OBO token's subject; undefined for a plain service token
  userId?: string;
}

export interface IRequestUserContext {
  accessToken: string | null;
  userInfo: IRequestUserInfo | null;
  permissions: string[];
  // true ONLY when identity came from a verified JWT; a session-capability or staged stub caller is not, so a
  // route that attributes work to a client (the job receiver) can refuse to trust serviceId without it.
  authenticated: boolean;
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
    const accessToken = bearerToken(req.headers.authorization);

    // authorityUrl present => validate as a host-issued RS256 JWT; issuer must match the authority
    if (accessToken && auth.authorityUrl) {
      try {
        const claims = await verifyIdentity(getKey, accessToken, { issuer: auth.authorityUrl });
        // OBO (act present): the SUBJECT is the user, the ACTOR is the calling service — so the service scope is
        // the actor's and the user identity is the subject. plain service token (no act): the subject IS the
        // service and the scope is top-level. Either way the CALLING SERVICE must carry agent:trigger, else the
        // token is valid but unauthorized — reject rather than fall through to the stub principal.
        const servicePermissions = claims.act ? claims.act.permissions : claims.permissions;
        if (!servicePermissions.includes("agent:trigger")) {
          res.status(403).json({ error: "forbidden" });
          return;
        }
        req.userContext = {
          accessToken: accessToken,
          userInfo: {
            serviceId: claims.act ? claims.act.sub : claims.sub,
            userId: claims.act ? claims.sub : undefined,
          },
          permissions: claims.permissions,
          authenticated: true,
        };
        next();
        return;
      } catch (err) {
        req.container.get(LOGGER).warn?.(`[agent-server] token verification failed: ${String(err)}`);
      }
    }

    // session-as-capability: a live session was minted by an authorized create, so its id authorizes follow-on calls without re-presenting a token (the job receiver still demands a JWT)
    const sessionId = req.header(SESSION_HEADER)?.trim();
    if (sessionId && sessions.get(sessionId)) {
      req.userContext = {
        accessToken: null,
        userInfo: { serviceId: sessionId },
        permissions: ["agent:trigger"],
        authenticated: false,
      };
      next();
      return;
    }

    if (auth.required) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    req.userContext = {
      accessToken,
      userInfo: { serviceId: "host" },
      permissions: ["agent:trigger"],
      authenticated: false,
    };
    next();
  };
}
