import type { Request, Response, NextFunction } from "express";
import {
  verifyIdentity,
  bearerToken,
  type JwtKeyResolver,
  type JwtOptions,
  type IdentityClaims,
  type ILogger,
} from "@agent-local/common";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      // the caller resolved for this request: identity from a verified bearer or the session ticket, or empty
      userContext: { permissions: string[]; userInfo: IdentityClaims | null; accessToken: string | null };
    }
  }
}

// resolves the caller for the host's OWN routes: a presented bearer (verified against the host's own keys) wins
// over the session cookie ticket, so a service client (the agent) and a browser session both land on one shape.
// non-blocking — absence leaves an empty context; route guards (requirePermission) do the enforcing.
export function userContextMiddleware(getKey: JwtKeyResolver, options: JwtOptions, logger: ILogger) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const presented = bearerToken(req.headers.authorization);
    if (presented) {
      try {
        const claims = await verifyIdentity(getKey, presented, options);
        req.userContext = { permissions: claims.permissions, userInfo: claims, accessToken: presented };
        next();
        return;
      } catch (err) {
        logger.warn?.(`[host] bearer verification failed: ${String(err)}`);
      }
    }
    const ticket = req.authTicket;
    req.userContext = ticket?.authenticated
      ? { permissions: ticket.claims.permissions, userInfo: ticket.claims, accessToken: ticket.accessToken }
      : { permissions: [], userInfo: null, accessToken: null };
    next();
  };
}

// route guard: 401 when unauthenticated, 403 when the resolved identity lacks the required permission
export function requirePermission(permission: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.userContext?.userInfo) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    if (!req.userContext.permissions.includes(permission)) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    next();
  };
}
