import { SessionManager } from "../../session-manager.js";
import type { IMiddleware, RuntimeContext } from "../types.js";

/**
 * SessionManagerMiddleware — builds the manager that owns sub-sessions spawned
 * within this session. It composes three earlier-built collaborators, so it
 * must run last among the subsystem steps.
 *
 * Reads ctx.orchestrator + ctx.inbox + ctx.store and sets ctx.sessionManager
 * before calling next(). Throws if any collaborator is missing, since the
 * manager cannot function without all three (place OrchestratorMiddleware,
 * InputInboxMiddleware, and StoreMiddleware before it).
 */
export class SessionManagerMiddleware implements IMiddleware {
  async initialize(ctx: RuntimeContext, next: () => Promise<void>): Promise<void> {
    if (!ctx.orchestrator || !ctx.inbox || !ctx.store) {
      const missing = [
        !ctx.orchestrator && "orchestrator (OrchestratorMiddleware)",
        !ctx.inbox && "inbox (InputInboxMiddleware)",
        !ctx.store && "store (StoreMiddleware)",
      ].filter(Boolean);
      throw new Error(
        `SessionManagerMiddleware: missing ${missing.join(", ")}. ` +
          "Add the listed step(s) earlier in the pipeline."
      );
    }

    ctx.sessionManager = new SessionManager(ctx.orchestrator, ctx.inbox, ctx.store);
    await next();
  }
}
