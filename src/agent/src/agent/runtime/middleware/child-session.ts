import { createSession } from "../../session.js";
import type { IMiddleware, RuntimeContext } from "../types.js";

export interface ChildSessionParams {
  /**
   * Pre-minted id for the child session. The coordinator mints this BEFORE the
   * runtime is built so it can return a snapshot synchronously; the same id then
   * becomes the child's sessionId here, keeping the inbox key and the persisted
   * file name aligned with what the parent was handed.
   */
  sessionId: string;
  /** The spawning (parent) session's id — links the child for store/picker filtering. */
  parentSessionId: string;
  /** Workspace inherited from the parent, so the child shares its sandbox segment. */
  workspaceId: string;
  /** Optional standing context seeded as a system message before the intent. */
  standingContext?: string;
}

/**
 * ChildSessionMiddleware — the sub-runtime's replacement for SessionMiddleware.
 *
 * Where the top-level step opens or resumes a session from disk, a sub-session
 * is born fresh and parent-fed: it mints a child Session with the given id and
 * the parent's workspaceId, seeds any standing context, stamps the inherited
 * identity (set by InheritedUserMiddleware just before), persists it, and
 * resolves the shared workspace. Sets ctx.session + ctx.workspace before next().
 */
export class ChildSessionMiddleware implements IMiddleware {
  constructor(private readonly params: ChildSessionParams) {}

  async initialize(ctx: RuntimeContext, next: () => Promise<void>): Promise<void> {
    if (!ctx.store || !ctx.workspaces) {
      throw new Error(
        "ChildSessionMiddleware: requires ctx.store and ctx.workspaces. Add StoreMiddleware " +
          "and WorkspaceRegistryMiddleware earlier in the sub-runtime pipeline."
      );
    }

    // Re-register the parent's workspace on this runtime's fresh registry so the
    // child resolves the same root/context. Idempotent for an existing segment.
    await ctx.workspaces.register(this.params.workspaceId, ctx.workspaceRoot);

    const session = createSession({
      sessionId: this.params.sessionId,
      workspaceId: this.params.workspaceId,
      parentSessionId: this.params.parentSessionId,
    });

    const standing = this.params.standingContext?.trim();
    if (standing && standing.length > 0) {
      session.conversation.push({
        role: "system",
        content: `Sub-session standing context:\n\n${standing}`,
      });
    }

    // Inherited identity was placed on ctx.user by InheritedUserMiddleware.
    if (ctx.user) session.user = ctx.user;

    await ctx.store.save(session);
    ctx.session = session;
    ctx.workspace = ctx.workspaces.get(this.params.workspaceId);
    await next();
  }
}
