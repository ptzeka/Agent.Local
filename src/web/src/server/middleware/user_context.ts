import type { Request, Response, NextFunction } from "express";
import { Permissions } from "../../providers/user_context";

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

// STUB identity: auth is not yet wired, so every request resolves the same placeholder console operator
// holding the Workflow permission (matches Permissions.Workflow). When OIDC lands this body is replaced
// with: read the session token, fetch userinfo + permissions, attach the real req.userContext.
export function userContextMiddleware() {
  return (req: Request, _res: Response, next: NextFunction): void => {
    req.userContext = {
      accessToken: "AccessTokenHidden",
      userInfo: { userId: "local", userName: "local@agent.local", firstName: "Local", lastName: "Operator" },
      permissions: [Permissions.Workflow],
    };
    next();
  };
}
