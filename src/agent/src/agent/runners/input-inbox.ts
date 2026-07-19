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

  public pop(sessionId: string): string
  {
    const queue = this.queues.get(sessionId);
    if (!queue || queue.length === 0) return "";
    return queue.pop() || "";
  }

  // FIFO drain-and-clear; called once per iteration, so a drained-and-empty session costs one Map miss
  public drain(sessionId: string): string[] {
    const queue = this.queues.get(sessionId);
    if (!queue || queue.length === 0) return [];
    this.queues.delete(sessionId);
    return queue;
  }

  public hasPending(sessionId: string): boolean {
    const queue = this.queues.get(sessionId);
    return queue !== undefined && queue.length > 0;
  }
}
