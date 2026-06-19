import type { Request, Response, NextFunction } from "express";
import type { Eventing } from "@agent-local/common";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      eventing: Eventing;
    }
  }
}

// attaches the host bus to every request so route handlers publish through req (the sender forwards
// agent.result to the host) instead of a closed-over reference — the bus is the one cross-engine seam.
export function eventingContextMiddleware(bus: Eventing) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    req.eventing = bus;
    next();
  };
}
