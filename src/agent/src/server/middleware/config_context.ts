import type { Request, Response, NextFunction } from "express";
import type { AgentServerSettings } from "../appsettings.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      serverConfig: AgentServerSettings;
    }
  }
}

// attaches the resolved agent settings to every request so handlers read one source of config off req
// instead of re-loading appsettings — the Sandbox/console put config first (logger and auth read from it),
// so this must be the first context middleware in the chain.
export function configContextMiddleware(config: AgentServerSettings) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    req.serverConfig = config;
    next();
  };
}
