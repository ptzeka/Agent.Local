import { randomUUID } from "node:crypto";

import { Conversation } from "../../conversation/conversation.js";
import { ConversationStore } from "../../conversation/conversation-store.js";
import { ConversationToken, SessionToken, StoreToken } from "../tokens.js";
import type { IMiddleware, RuntimeContext } from "../types.js";

export interface ConversationMiddlewareParams {
  // sub-runtime's parent-fed briefing, seeded only into a FRESH conversation so a resume can't re-seed
  standingContext?: string;
}

// opens the session's conversation after the session step, following session.conversationId to the rolling file
// also heals a crash-interrupted transcript on resume by trimming a dangling tool_use tail
export class ConversationMiddleware implements IMiddleware {
  constructor(private readonly params: ConversationMiddlewareParams = {}) {}

  async initialize(ctx: RuntimeContext, next: () => Promise<void>): Promise<void> {
    const session = ctx.registry.get(SessionToken);
    const store = ConversationStore.create(ctx.sessionsDir);

    // mint a fresh link for a missing or soft-deleted id; reusing a deleted one would resurrect the audit copy
    if (!session.conversationId || (await store.isDeleted(session.conversationId))) {
      session.conversationId = randomUUID();
      await ctx.registry.get(StoreToken).save(session);
    }
    const conversation = await Conversation.open(store, session.conversationId);

    await conversation.trimDanglingToolCalls();

    const standing = this.params.standingContext?.trim();
    if (standing && standing.length > 0 && conversation.length === 0) {
      conversation.append({
        role: "system",
        content: `Sub-session standing context:\n\n${standing}`,
      });
      await conversation.flush();
    }

    ctx.registry.set(ConversationToken, conversation);
    await next();
  }
}
