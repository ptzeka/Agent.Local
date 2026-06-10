import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import { createSession } from "../../session.js";
import type { IMiddleware, RuntimeContext } from "../types.js";

export interface SessionMiddlewareParams {
  /**
   * Session id to resume from disk. Omit (or leave undefined) to open a
   * fresh session.
   */
  sessionId?: string;
  /**
   * Workspace id to join. When resuming an existing session this is ignored
   * (the session already carries its workspaceId). When opening a new session
   * it lets multiple sessions share one workspace — omit to mint a fresh one.
   */
  workspaceId?: string;
}

/**
 * SessionMiddleware — initialize-pipeline step that either resumes a persisted
 * session from disk or opens a brand-new one, then registers its workspace so
 * the project context is available for the rest of the pipeline.
 *
 * Expects ctx.user to already be set by IdentityMiddleware + AnonymousMiddleware.
 * Stamps session.user from ctx.user so the identity is durable on the session.
 *
 * Sets ctx.session and ctx.workspace before calling next().
 */
export class SessionMiddleware implements IMiddleware {
  constructor(private readonly params: SessionMiddlewareParams = {}) {}

  async initialize(ctx: RuntimeContext, next: () => Promise<void>): Promise<void> {
    if (!ctx.store || !ctx.workspaces) {
      throw new Error(
        "SessionMiddleware: requires ctx.store and ctx.workspaces. Add StoreMiddleware " +
          "and WorkspaceRegistryMiddleware earlier in the pipeline."
      );
    }

    if (this.params.sessionId) {
      await this.resume(ctx, this.params.sessionId);
    } else {
      await this.open(ctx);
    }

    // Stamp the resolved identity onto the session so it's persisted with it.
    if (ctx.user) {
      ctx.session!.user = ctx.user;
    }

    ctx.workspace = ctx.workspaces!.get(ctx.session!.workspaceId);

    // Materialise the session's workspace segment on disk. ScopedToolClient
    // confines tool I/O to {sandboxRoot}/{workspaceId}; without the directory
    // the first list_dir/glob fails with ENOENT (scandir). recursive: true is
    // idempotent, so a resumed session with an existing segment is a no-op.
    const segmentDir = path.join(ctx.mcpRegistry.sandboxRoot, ctx.session!.workspaceId);
    await mkdir(segmentDir, { recursive: true });

    await next();
  }

  private async resume(ctx: RuntimeContext, sessionId: string): Promise<void> {
    const session = await ctx.store!.load(sessionId);
    if (!session) {
      throw new Error(`No persisted session "${sessionId}" to resume.`);
    }

    // A "running" status left over from a crashed process has no live turn
    // behind it after restart — reset so the session is dispatchable again.
    if (session.status === "running") {
      session.status = "awaiting-input";
    }

    // Drop a dangling tool_use tail: if the previous run was interrupted after
    // the assistant's tool_use was recorded but before its result arrived, the
    // next user message would land right after an unanswered tool_use. Trim it
    // here so the transcript is clean on resume. (The Anthropic provider also
    // heals this at send-time; trimming keeps the persisted file clean too.)
    const last = session.conversation[session.conversation.length - 1];
    if (last?.role === "assistant" && last.toolCalls && last.toolCalls.length > 0) {
      session.conversation.pop();
    }

    await ctx.workspaces!.register(session.workspaceId, ctx.workspaceRoot);
    ctx.session = session;
  }

  private async open(ctx: RuntimeContext): Promise<void> {
    const workspaceId = this.params.workspaceId ?? randomUUID();
    await ctx.workspaces!.register(workspaceId, ctx.workspaceRoot);

    const session = createSession({
      sessionId: randomUUID(),
      workspaceId,
    });

    await ctx.store!.save(session);
    ctx.session = session;
  }
}
