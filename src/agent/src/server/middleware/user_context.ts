import type { Request, Response, NextFunction } from "express";
import { verifyIdentity, bearerToken, type JwtKeyResolver } from "@agent-local/common";
import { LOGGER, SERVER_CONFIG } from "../container-tokens.js";

// the principal that called this service. host -> agent is service-to-service, so the actor is always the
// calling SERVICE (serviceId). userId is the token's SUBJECT — the acting user, always present now: a human on an
// OBO (RFC 8693) call, or the workflow-user (host-dispatch) on a plain service token. Every session is owned by a
// userId, so session touches are gated on it. Shape mirrors the Sandbox/console req.userContext.
export interface IRequestUserInfo {
  serviceId: string;
  // the acting user, from the token's subject: the human (OBO) or the workflow-user (plain dispatch token)
  userId: string;
}

export interface IRequestUserContext {
  accessToken: string | null;
  userInfo: IRequestUserInfo | null;
  permissions: string[];
  // identity now comes ONLY from a verified JWT, so this is always true when userContext is set; kept as the seam
  // a route that attributes work to a client (the job receiver) reads before trusting serviceId.
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

// resolves the caller from the verified bearer JWT ALONE: identity is always the token's SUBJECT (a human via an
// OBO token, the workflow-user via the host's own dispatch token). No session-id capability and no staged host stub
// any more — a session id is not a principal. The calling service must carry agent:trigger; anything else is 401.
export function userContextMiddleware(getKey: JwtKeyResolver) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const auth = req.container.get(SERVER_CONFIG).authentication;
    const accessToken = bearerToken(req.headers.authorization);

    // authorityUrl present => validate as a host-issued RS256 JWT; issuer must match the authority
    if (accessToken && auth.authorityUrl) {
      try {
        const claims = await verifyIdentity(getKey, accessToken, { issuer: auth.authorityUrl });
        // OBO (act present): the SUBJECT is the user, the ACTOR is the calling service. plain token (no act): the
        // subject IS the service, itself a user principal (the workflow-user, host-dispatch). Either way the SUBJECT
        // is the acting user (surfaced as userId), and the CALLING SERVICE must carry agent:trigger, else the token
        // is valid but unauthorized.
        const servicePermissions = claims.act ? claims.act.permissions : claims.permissions;
        if (!servicePermissions.includes("agent:trigger")) {
          res.status(403).json({ error: "forbidden" });
          return;
        }
        req.userContext = {
          accessToken: accessToken,
          userInfo: {
            serviceId: claims.act ? claims.act.sub : claims.sub,
            userId: claims.sub,
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

    res.status(401).json({ error: "unauthorized" });
  };
}
