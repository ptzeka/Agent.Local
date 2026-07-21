// injection is PULL, not push: the orchestrator is the sole writer of the Conversation, so an
// outside mutation would race the in-flight loop; producers enqueue here and the loop drains at a safe boundary
// keyed by sessionId so one inbox serves the top session and every detached sub-session; in-memory transient steering
export class InputInbox {
  private readonly queues = new Map<string, string[]>();

  // the single injection interface is also the wake source, so producers don't drive the scheduler directly
  private onPush: ((source?: string) => void) | null = null;

  // runtime points this at the turn runner so pushing content un-parks a drained-and-idle session
  public setOnPush(listener: ((source?: string) => void) | null): void {
    this.onPush = listener;
  }

  // source tags the wake so the scheduled turn knows who produced it (user vs subsession)
  public push(sessionId: string, content: string, source?: string): void {
    const trimmed = content.trim();
    if (trimmed.length === 0) return;
    const queue = this.queues.get(sessionId);
    if (queue) {
      queue.push(trimmed);
    } else {
      this.queues.set(sessionId, [trimmed]);
    }
    // wake AFTER queuing so the scheduler always finds the content on drain
    this.onPush?.(source);
  }

  // pops ONE queued prompt in FIFO order so each becomes its own turn; drops the queue when it empties
  public dequeue(sessionId: string): string {
    const queue = this.queues.get(sessionId);
    if (!queue || queue.length === 0) return "";
    const next = queue.shift()!;
    if (queue.length === 0) this.queues.delete(sessionId);
    return next;
  }

  public hasPending(sessionId: string): boolean {
    const queue = this.queues.get(sessionId);
    return queue !== undefined && queue.length > 0;
  }

  // a hard stop drops queued prompts so they don't auto-run after the user cancels
  public clear(sessionId: string): void {
    this.queues.delete(sessionId);
  }
}
