import { randomUUID } from "node:crypto";

import { createSession } from "../../session/session.js";
import { SessionToken, StoreToken, UserToken, WorkspaceToken, WorkspacesToken } from "../tokens.js";
import type { IMiddleware, RuntimeContext } from "../types.js";

export interface ChildSessionParams {
  // minted by the coordinator BEFORE build so it can answer synchronously; reused here to keep inbox key and file name aligned
  sessionId: string;
  // links the child for store/picker filtering
  parentSessionId: string;
  // inherited so the child shares the parent's sandbox segment
  workspaceId: string;
}

// the sub-runtime's replacement for SessionMiddleware: a child is born fresh and parent-fed, never resumed
// mints the session with the given id + parent's workspace, stamps inherited identity, persists, resolves the shared workspace
export class ChildSessionMiddleware implements IMiddleware {
  constructor(private readonly params: ChildSessionParams) {}

  async initialize(ctx: RuntimeContext, next: () => Promise<void>): Promise<void> {
    const workspaces = ctx.registry.get(WorkspacesToken);

    // re-register on this runtime's fresh registry so the child resolves the same root/context
    await workspaces.register(this.params.workspaceId, ctx.workspaceRoot);

    const session = createSession({
      sessionId: this.params.sessionId,
      workspaceId: this.params.workspaceId,
      conversationId: randomUUID(),
      parentSessionId: this.params.parentSessionId,
    });

    const user = ctx.registry.tryGet(UserToken);
    if (user) session.user = user;

    await ctx.registry.get(StoreToken).save(session);
    ctx.registry.set(SessionToken, session);
    ctx.registry.set(WorkspaceToken, workspaces.get(this.params.workspaceId));
    await next();
  }
}
