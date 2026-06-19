import type { Request, Response, NextFunction } from "express";
import type { ILogger } from "@agent-local/common";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      logger: ILogger;
    }
  }
}

// attaches the service logger to every request so route handlers log through one sink instead of a
// closed-over module global — second in the chain (after configContext) like the Sandbox/console.
export function loggerContextMiddleware(logger: ILogger) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    req.logger = logger;
    next();
  };
}
