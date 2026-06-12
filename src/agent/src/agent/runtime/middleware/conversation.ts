import { randomUUID } from "node:crypto";

import { Conversation } from "../../conversation/conversation.js";
import { ConversationStore } from "../../conversation/conversation-store.js";
import type { IMiddleware, RuntimeContext } from "../types.js";

export interface ConversationMiddlewareParams {
  /**
   * Optional standing context seeded as the first system message of a FRESH
   * conversation — the sub-runtime's parent-fed briefing. Ignored when the
   * conversation already has messages (a resume must not re-seed).
   */
  standingContext?: string;
}

/**
 * ConversationMiddleware — opens the session's conversation.
 *
 * Runs after the session step (SessionMiddleware or ChildSessionMiddleware):
 * it follows `session.conversationId` to the rolling JSONL file and loads it,
 * or starts empty for a fresh session. Sessions persisted before the
 * conversation split carry no conversationId — those get a fresh id stamped
 * here (their embedded transcript is NOT migrated, by decision).
 *
 * Also heals a crash-interrupted transcript on resume by trimming a dangling
 * tool_use tail — this lived in SessionMiddleware when the transcript lived on
 * the session. Sets ctx.conversation before calling next().
 */
export class ConversationMiddleware implements IMiddleware {
  constructor(private readonly params: ConversationMiddlewareParams = {}) {}

  async initialize(ctx: RuntimeContext, next: () => Promise<void>): Promise<void> {
    if (!ctx.session || !ctx.store) {
      throw new Error(
        "ConversationMiddleware: requires ctx.session and ctx.store. Add a session step " +
          "(SessionMiddleware / ChildSessionMiddleware) earlier in the pipeline."
      );
    }

    const store = ConversationStore.create(ctx.sessionsDir);

    // Pre-split session files have no conversationId; mint and persist the
    // link so the next resume finds the same (new, empty) conversation.
    // A link pointing at a soft-deleted conversation gets the same treatment:
    // reusing the id would resurrect (append to) the audit copy.
    if (!ctx.session.conversationId || (await store.isDeleted(ctx.session.conversationId))) {
      ctx.session.conversationId = randomUUID();
      await ctx.store.save(ctx.session);
    }
    const conversation = await Conversation.open(store, ctx.session.conversationId);

    await conversation.trimDanglingToolCalls();

    const standing = this.params.standingContext?.trim();
    if (standing && standing.length > 0 && conversation.length === 0) {
      conversation.append({
        role: "system",
        content: `Sub-session standing context:\n\n${standing}`,
      });
      await conversation.flush();
    }

    ctx.conversation = conversation;
    await next();
  }
}
