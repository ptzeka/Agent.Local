import type { ChatMessage } from "../providers/provider.js";
import type { ConversationStore } from "./conversation-store.js";

// transcript state split out of Session, which keeps only the conversationId link
// flushedCount is the disk watermark, so a flush appends only the new tail, never a full rewrite
// writes chain through pendingWrite so an end-of-round flush can't interleave with a summarization rewrite
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

  // loaded messages count as flushed since they came from disk
  // ensureMeta stamps createdAt the first time a conversation comes alive
  public static async open(store: ConversationStore, conversationId: string): Promise<Conversation> {
    await store.ensureMeta(conversationId);
    const messages = (await store.load(conversationId)) ?? [];
    return new Conversation(conversationId, store, messages);
  }

  public get length(): number {
    return this.messages.length;
  }

  // readonly: mutation must go through append/replaceAll so the disk watermark stays truthful
  public getMessages(): readonly ChatMessage[] {
    return this.messages;
  }

  // synchronous and disk-free; the next flush persists what was added
  public append(...messages: ChatMessage[]): void {
    this.messages.push(...messages);
  }

  public flush(): Promise<void> {
    return this.enqueue(async () => {
      if (this.flushedCount >= this.messages.length) return;
      // capture bounds before awaiting: messages appended mid-write belong to the NEXT flush
      const upTo = this.messages.length;
      await this.store.append(this.conversationId, this.messages.slice(this.flushedCount, upTo));
      this.flushedCount = upTo;
    });
  }

  // summarization/compaction: rewrites the file atomically, keeping the outgoing generation as backup
  public replaceAll(messages: ChatMessage[]): Promise<void> {
    this.messages.length = 0;
    this.messages.push(...messages);
    // move the watermark with the swap so a flush queued ahead sees "nothing to append"
    this.flushedCount = this.messages.length;
    return this.enqueue(async () => {
      await this.store.rewrite(this.conversationId, this.messages, { backup: true });
      this.flushedCount = this.messages.length;
    });
  }

  // session-reset path: after this the conversation must not be appended to (session links a fresh one)
  public markDeleted(): Promise<void> {
    return this.enqueue(async () => {
      await this.store.markDeleted(this.conversationId);
    });
  }

  // resume healing: an interrupted run can leave a tool_use with no result, which the
  // next user message would illegally follow; drop that tail and rewrite if already persisted
  public async trimDanglingToolCalls(): Promise<boolean> {
    const last = this.messages[this.messages.length - 1];
    if (!(last?.role === "assistant" && last.toolCalls && last.toolCalls.length > 0)) {
      return false;
    }
    this.messages.pop();
    if (this.flushedCount > this.messages.length) {
      await this.enqueue(async () => {
        // no backup: dropping one dangling tool_use is healing, not history
        await this.store.rewrite(this.conversationId, this.messages);
        this.flushedCount = this.messages.length;
      });
    }
    return true;
  }

  // serialises disk operations so flushes and rewrites never interleave
  private enqueue(operation: () => Promise<void>): Promise<void> {
    this.pendingWrite = this.pendingWrite.then(operation);
    return this.pendingWrite;
  }
}
