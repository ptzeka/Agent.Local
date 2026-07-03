import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import { createSession, memoryCollectionFor, type Session } from "../../session/session.js";
import { SessionToken, StoreToken, UserToken, WorkspaceToken, WorkspacesToken } from "../tokens.js";
import type { IMiddleware, RuntimeContext } from "../types.js";

export interface SessionMiddlewareParams {
  // omit to open a fresh session
  sessionId?: string;
  // ignored when resuming; on a new session it lets multiple sessions share one workspace, else minted fresh
  workspaceId?: string;
}

// resumes a persisted session or opens a new one, then registers its workspace for the rest of the pipeline
// stamps session.user from ctx.user (set by Identity+Anonymous) so identity is durable on the session
export class SessionMiddleware implements IMiddleware {
  constructor(private readonly params: SessionMiddlewareParams = {}) {}

  async initialize(ctx: RuntimeContext, next: () => Promise<void>): Promise<void> {
    const session = this.params.sessionId
      ? await this.resume(ctx, this.params.sessionId)
      : await this.open(ctx);

    const user = ctx.registry.tryGet(UserToken);
    // resume gate: a session owned by an authenticated user only reopens for that user. An unowned or
    // anonymous session may be adopted by whoever resumes it (login-then-resume), and the owner restamping
    // themselves just refreshes claims. Without this, resuming by id would silently transfer ownership.
    if (this.params.sessionId) {
      const owner = session.user;
      if (owner?.isAuthenticated && (!user?.isAuthenticated || user.sub !== owner.sub)) {
        throw new Error(`Session "${session.sessionId}" belongs to another user.`);
      }
    }
    if (user) {
      session.user = user;
    }
    session.memoryCollectionId = memoryCollectionFor(session)
    ctx.registry.set(SessionToken, session);

    const workspace = ctx.registry.get(WorkspacesToken).get(session.workspaceId);
    ctx.registry.set(WorkspaceToken, workspace);

    // create the sandbox segment up front or the first list_dir/glob fails with ENOENT; recursive is idempotent on resume
    const segmentDir = path.join(ctx.sandboxRoot, session.workspaceId);
    await mkdir(segmentDir, { recursive: true });

    await next();
  }

  private async resume(ctx: RuntimeContext, sessionId: string): Promise<Session> {
    const session = await ctx.registry.get(StoreToken).getSessionById(sessionId);
    if (!session) {
      throw new Error(`No persisted session "${sessionId}" to resume.`);
    }

    // a "running" status from a crashed process has no live turn after restart; reset so it's dispatchable
    if (session.status === "running") {
      session.status = "awaiting-input";
    }

    await ctx.registry.get(WorkspacesToken).register(session.workspaceId, ctx.workspaceRoot);
    return session;
  }

  private async open(ctx: RuntimeContext): Promise<Session> {
    const workspaceId = this.params.workspaceId ?? randomUUID();
    await ctx.registry.get(WorkspacesToken).register(workspaceId, ctx.workspaceRoot);

    const session = createSession({
      sessionId: randomUUID(),
      workspaceId,
      conversationId: randomUUID(),
    });

    await ctx.registry.get(StoreToken).save(session);
    return session;
  }
}
