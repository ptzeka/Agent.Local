import type { Request, Response, NextFunction } from "express";
import { openTicket, cookieValue, SESSION_COOKIE_NAME, type AuthTicket } from "@agent-local/common";
import type { ResolveUser } from "@agent-local/web";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      // the opened session ticket for this request, or null when there is no valid (present, unexpired) cookie
      authTicket: AuthTicket | null;
    }
  }
}

// the single "decrypt at middleware" seam: opens the encrypted session cookie ONCE per request and stashes the
// ticket on req, so the auth routes and the web SSR resolver both read it without each re-decrypting.
export function sessionMiddleware(key: Uint8Array) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    req.authTicket = await openTicket(cookieValue(req.headers.cookie, SESSION_COOKIE_NAME), key);
    next();
  };
}

// the web SSR seam: hands the console the caller's identity from the already-opened ticket, or null when the
// session is absent/expired so the app renders unauthenticated. accessToken is the bearer forwarded to the agent.
export const resolveUserFromRequest: ResolveUser = (req: Request) => {
  const ticket = req.authTicket;
  if (!ticket?.authenticated) return null;
  const { sub, userName, firstName, lastName, permissions } = ticket.claims;
  return { userInfo: { userId: sub, userName, firstName, lastName }, permissions, accessToken: ticket.accessToken };
};
