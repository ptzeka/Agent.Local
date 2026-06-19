import type { Request, Response, NextFunction } from "express";
import { Permissions } from "../../providers/user_context.js";
import type { ResolveUser } from "../mount.js";

// the identity attached to each request. Mirrors the sandbox's req.userContext shape so real OIDC
// drops in behind it later — only this middleware changes, ssr_render already reads from here.
export interface IRequestUserInfo {
  userId: string;
  userName: string;
  firstName: string;
  lastName: string;
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

// resolves req.userContext from the host's session ticket (resolveUser decrypts the cookie host-side): a valid
// session attaches the real identity + permissions; a missing/expired one (null) renders unauthenticated so the
// app routes to login. Without a resolver (standalone web, no host auth) it falls back to the stub operator.
export function userContextMiddleware(resolveUser?: ResolveUser) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    if (!resolveUser) {
      req.userContext = {
        accessToken: "AccessTokenHidden",
        userInfo: { userId: "local", userName: "local@agent.local", firstName: "Local", lastName: "Operator" },
        permissions: [Permissions.WorkflowRead, Permissions.WorkflowWrite],
      };
      next();
      return;
    }
    const user = await resolveUser(req);
    req.userContext = user
      ? { accessToken: user.accessToken, userInfo: user.userInfo, permissions: user.permissions }
      : { accessToken: null, userInfo: null, permissions: [] };
    next();
  };
}
