import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";

import { Conversation } from "../../src/agent/conversation/conversation.js";
import { ConversationStore } from "../../src/agent/conversation/conversation-store.js";
import { ConversationMiddleware } from "../../src/agent/runtime/middleware/conversation.js";
import { ConversationToken } from "../../src/agent/runtime/tokens.js";
import { SessionStore } from "../../src/agent/session/session-store.js";
import { createSession, type Session } from "../../src/agent/session/session.js";
import type { DatabaseHandle } from "@agent-local/common/db";
import { makeContext, makeTestDb } from "./context.js";

// the transcript lives in conversations/messages rows linked from the session by conversationId. Covers the
// store round-trip, the append/flush watermark, structural rewrites, and the middleware's resume heal + backfill
describe("Conversation", () => {
  let db: DatabaseHandle;
  let store: ConversationStore;

  beforeEach(() => {
    db = makeTestDb();
    store = ConversationStore.create(db);
  });

  afterEach(() => {
    db.close();
  });

  test("flush appends only the unpersisted tail; reopening loads the full transcript", async () => {
    const conversation = await Conversation.open(store, "c-1");
    conversation.append({ role: "user", content: "first" });
    conversation.append({ role: "assistant", content: "second\nwith newline" });
    await conversation.flush();

    conversation.append({ role: "user", content: "third" });
    await conversation.flush();
    // A second flush with nothing new must not duplicate lines.
    await conversation.flush();

    const reopened = await Conversation.open(store, "c-1");
    expect(reopened.getMessages().map((m) => m.content)).toEqual([
      "first",
      "second\nwith newline",
      "third",
    ]);
  });

  test("replaceAll rewrites the transcript to the new generation", async () => {
    const conversation = await Conversation.open(store, "c-2");
    conversation.append({ role: "user", content: "a" }, { role: "assistant", content: "b" });
    await conversation.flush();

    await conversation.replaceAll([{ role: "system", content: "summary" }]);

    const reopened = await Conversation.open(store, "c-2");
    expect(reopened.getMessages()).toEqual([{ role: "system", content: "summary" }]);
  });

  test("markDeleted stamps deletedAt and hides the transcript from load", async () => {
    const conversation = await Conversation.open(store, "c-4");
    conversation.append({ role: "user", content: "sensitive" });
    await conversation.flush();

    await conversation.markDeleted();

    // Filtered out of every normal select…
    expect(await store.load("c-4")).toBeNull();
    const meta = await store.readMeta("c-4");
    expect(meta?.createdAt).toBeGreaterThan(0);
    expect(meta?.deletedAt).toBeGreaterThanOrEqual(meta!.createdAt);
    // …and the soft-delete is idempotent — a repeat keeps the original deletedAt
    const again = await store.markDeleted("c-4");
    expect(again.deletedAt).toBe(meta!.deletedAt);
  });

  test("trimDanglingToolCalls drops an unanswered tool_use tail and persists the trim", async () => {
    const conversation = await Conversation.open(store, "c-3");
    conversation.append(
      { role: "user", content: "do the thing" },
      { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "noop", arguments: {} }] }
    );
    await conversation.flush();

    const trimmed = await conversation.trimDanglingToolCalls();
    expect(trimmed).toBe(true);

    const reopened = await Conversation.open(store, "c-3");
    expect(reopened.length).toBe(1);
    expect(reopened.getMessages()[0].role).toBe("user");
  });
});

describe("ConversationMiddleware", () => {
  let db: DatabaseHandle;
  let sessionStore: SessionStore;

  beforeEach(() => {
    db = makeTestDb();
    sessionStore = SessionStore.create(db);
  });

  afterEach(() => {
    db.close();
  });

  test("opens the conversation linked from the session and sets ctx.conversation", async () => {
    const session = createSession({ sessionId: "s1", workspaceId: "ws-1", conversationId: "c1" });
    const ctx = makeContext({ db, store: sessionStore, session });
    const next = jest.fn(async () => {});

    await new ConversationMiddleware().initialize(ctx, next);

    expect(ctx.registry.tryGet(ConversationToken)).toBeDefined();
    expect(ctx.registry.get(ConversationToken).conversationId).toBe("c1");
    expect(next).toHaveBeenCalledTimes(1);
  });

  test("backfills a conversationId on a pre-split session and persists the link", async () => {
    const session = createSession({ sessionId: "s2", workspaceId: "ws-1", conversationId: "c2" });
    // Simulate a session persisted before the split: no conversationId stored.
    (session as Partial<Session>).conversationId = undefined;
    await sessionStore.save(session);

    const ctx = makeContext({ db, store: sessionStore, session });
    await new ConversationMiddleware().initialize(ctx, jest.fn(async () => {}));

    expect(session.conversationId).toBeDefined();
    expect((await sessionStore.getSessionById("s2"))?.conversationId).toBe(session.conversationId);
  });

  test("relinks to a fresh conversation when the session points at a soft-deleted one", async () => {
    const conversationStore = ConversationStore.create(db);
    await conversationStore.append("c3", [{ role: "user", content: "old" }]);
    await conversationStore.markDeleted("c3");

    const session = createSession({ sessionId: "s3", workspaceId: "ws-1", conversationId: "c3" });
    const ctx = makeContext({ db, store: sessionStore, session });
    await new ConversationMiddleware().initialize(ctx, jest.fn(async () => {}));

    // The deleted conversation must never be resurrected — new id, empty transcript.
    expect(session.conversationId).not.toBe("c3");
    expect(ctx.registry.get(ConversationToken).conversationId).toBe(session.conversationId);
    expect(ctx.registry.get(ConversationToken).length).toBe(0);
  });

  test("throws without a session step earlier in the pipeline", async () => {
    const ctx = makeContext({ db, store: sessionStore });
    await expect(
      new ConversationMiddleware().initialize(ctx, jest.fn(async () => {}))
    ).rejects.toThrow(/no instance registered for "session"/);
  });
});
