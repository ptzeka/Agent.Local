import type { Request, Response, NextFunction } from "express";
import { openTicket, cookieValue, SESSION_COOKIE_NAME, type AuthTicket } from "@agent-local/common";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      // the opened session ticket for this request, or null when there is no valid (present, unexpired) cookie
      authTicket: AuthTicket | null;
    }
  }
}

// the "decrypt at middleware" seam: opens the encrypted session cookie ONCE per request and stashes the ticket
// on req, so the account routes (/account/me, /account/accesstoken) read it without re-decrypting. The cookie is
// sealed here at login and OPENED by the host too (shared session secret), so both agree on one ticket format.
export function sessionMiddleware(key: Uint8Array) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    req.authTicket = await openTicket(cookieValue(req.headers.cookie, SESSION_COOKIE_NAME), key);
    next();
  };
}
