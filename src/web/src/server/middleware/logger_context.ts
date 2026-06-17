import type { Request, Response, NextFunction } from "express";

// minimal server logger contract — the host passes its ILogger through; every method optional so a
// bare console works too. ssr_render and the SSE bridge read req.logger instead of a module global.
export interface IServerLogger {
  debug?: (message: string, ...args: unknown[]) => void;
  info?: (message: string, ...args: unknown[]) => void;
  warn?: (message: string, ...args: unknown[]) => void;
  error?: (message: string, error?: unknown) => void;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      logger: IServerLogger;
    }
  }
}

// attaches the host logger to every request so downstream middleware log through one sink.
export function loggerContextMiddleware(logger: IServerLogger) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    req.logger = logger;
    next();
  };
}
