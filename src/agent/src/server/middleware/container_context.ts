import type { Request, Response, NextFunction } from "express";
import type { Container } from "@agent-local/common";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      container: Container;
    }
  }
}

// attaches the ONE startup container to every request — a reference pass, nothing is built per request, so the
// singletons it holds (logger, settings, bus, db, the token-cache store) keep their in-memory state across calls.
// replaces the per-key config/logger/eventing context middlewares: handlers now read req.container.get(handle).
export function containerMiddleware(container: Container) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    req.container = container;
    next();
  };
}
