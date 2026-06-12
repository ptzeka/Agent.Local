import type { ChatMessage } from "../providers/provider.js";
import type { ConversationStore } from "./conversation-store.js";

/**
 * Conversation — the unit of transcript state, split out of `Session`.
 *
 * The session keeps only the `conversationId` link; the messages live here and
 * in a rolling JSONL file owned by the ConversationStore. The in-memory array
 * is the working copy the orchestrator appends to during a turn; `flushedCount`
 * is the watermark of how many of those messages are already on disk, so a
 * flush appends ONLY the new tail instead of rewriting the transcript.
 *
 * Writes are chained through `pendingWrite` so an end-of-round flush can never
 * interleave with a summarization rewrite racing it.
 */
export class Conversation {
  private flushedCount: number;
  private pendingWrite: Promise<void> = Promise.resolve();

  private constructor(
    public readonly conversationId: string,
    private readonly store: ConversationStore,
    private readonly messages: ChatMessage[]
  ) {
    this.flushedCount = messages.length;
  }

  /**
   * Open a conversation by id: load the rolling file when it exists, start
   * empty otherwise. Loaded messages count as flushed — they came FROM disk.
   * Ensures the lifecycle record exists so `createdAt` is stamped the first
   * time a conversation comes alive.
   */
  public static async open(store: ConversationStore, conversationId: string): Promise<Conversation> {
    await store.ensureMeta(conversationId);
    const messages = (await store.load(conversationId)) ?? [];
    return new Conversation(conversationId, store, messages);
  }

  public get length(): number {
    return this.messages.length;
  }

  /** Live view of the transcript. Readonly: all mutation must go through
   *  append/replaceAll so the disk watermark stays truthful. */
  public getMessages(): readonly ChatMessage[] {
    return this.messages;
  }

  /** Add messages to the in-memory transcript. Cheap and synchronous — disk is
   *  only touched by the next flush (end of round / finalize). */
  public append(...messages: ChatMessage[]): void {
    this.messages.push(...messages);
  }

  /** Append every not-yet-persisted message to the rolling file. */
  public flush(): Promise<void> {
    return this.enqueue(async () => {
      if (this.flushedCount >= this.messages.length) return;
      // Capture the slice bounds before awaiting: append() may add more
      // messages while the write is in flight; they belong to the NEXT flush.
      const upTo = this.messages.length;
      await this.store.append(this.conversationId, this.messages.slice(this.flushedCount, upTo));
      this.flushedCount = upTo;
    });
  }

  /**
   * Replace the whole transcript (summarization, compaction) and rewrite the
   * file atomically; the outgoing generation is kept as `<id>.bak.json`.
   * After this the entire new content is on disk.
   */
  public replaceAll(messages: ChatMessage[]): Promise<void> {
    this.messages.length = 0;
    this.messages.push(...messages);
    // Move the watermark synchronously with the swap: a flush already queued
    // ahead of the rewrite must see "nothing to append", not splice new-
    // transcript lines onto the old file.
    this.flushedCount = this.messages.length;
    return this.enqueue(async () => {
      await this.store.rewrite(this.conversationId, this.messages, { backup: true });
      this.flushedCount = this.messages.length;
    });
  }

  /**
   * Soft-delete this conversation — the session-reset path. The transcript is
   * retained on disk as `<id>.deleted.json` for audit; from here on the
   * conversation must not be appended to (the session links a fresh one).
   */
  public markDeleted(): Promise<void> {
    return this.enqueue(async () => {
      await this.store.markDeleted(this.conversationId);
    });
  }

  /**
   * Drop a dangling tool_use tail: if a previous run was interrupted after the
   * assistant's tool_use was recorded but before its result arrived, the next
   * user message would land right after an unanswered tool_use. Called on
   * resume; rewrites the file when the trimmed message was already persisted.
   */
  public async trimDanglingToolCalls(): Promise<boolean> {
    const last = this.messages[this.messages.length - 1];
    if (!(last?.role === "assistant" && last.toolCalls && last.toolCalls.length > 0)) {
      return false;
    }
    this.messages.pop();
    if (this.flushedCount > this.messages.length) {
      await this.enqueue(async () => {
        // No backup: dropping one dangling tool_use is healing, not history.
        await this.store.rewrite(this.conversationId, this.messages);
        this.flushedCount = this.messages.length;
      });
    }
    return true;
  }

  /** Serialize disk operations so flushes and rewrites never interleave. */
  private enqueue(operation: () => Promise<void>): Promise<void> {
    this.pendingWrite = this.pendingWrite.then(operation);
    return this.pendingWrite;
  }
}
