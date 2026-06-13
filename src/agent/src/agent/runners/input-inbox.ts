/**
 * InputInbox — Service-layer seam for injecting prompts into a live session.
 *
 * The orchestrator is the SOLE writer of the session's Conversation; letting an
 * outside caller mutate the transcript directly would race the in-flight loop (the
 * same race the Initializer's `running` guard exists to prevent). So injection
 * is modelled as PULL, not push: external producers (a REPL command today, an
 * HTTP API tomorrow) enqueue here, and the orchestrator DRAINS the queue at a
 * safe boundary (the top of each loop iteration) and appends the items as
 * `role:"user"` messages itself.
 *
 * Keyed by `sessionId` so one shared inbox serves the top-level session and
 * every detached sub-session. In-memory only — pending prompts do not survive
 * a restart, which is acceptable: they are transient steering, not state.
 *
 * As the SINGLE injection interface, the inbox is also the wake source: a push
 * fires `onPush` so the scheduler knows there is work to run, instead of each
 * producer driving the turn scheduler directly.
 */
export class InputInbox {
  private readonly queues = new Map<string, string[]>();

  /** Fired after a successful non-empty push so the host can schedule a turn.
   *  Carries the push `source` so the wake can tag the turn it starts. In-memory
   *  wake seam — set by the runtime, never serialized. */
  private onPush: ((source?: string) => void) | null = null;

  /** Register the wake callback. The runtime points this at the turn runner so
   *  pushing content is what un-parks a drained-and-idle session. */
  public setOnPush(listener: ((source?: string) => void) | null): void {
    this.onPush = listener;
  }

  /** Enqueue a prompt for `sessionId`. The `source` tag flows to the wake
   *  listener so the scheduled turn knows who produced it (user vs subsession). */
  public push(sessionId: string, content: string, source?: string): void {
    const trimmed = content.trim();
    if (trimmed.length === 0) return;
    const queue = this.queues.get(sessionId);
    if (queue) {
      queue.push(trimmed);
    } else {
      this.queues.set(sessionId, [trimmed]);
    }
    // Wake AFTER the content is queued so the scheduler always finds it on drain.
    this.onPush?.(source);
  }

  /**
   * Return everything queued for `sessionId` in FIFO order and clear it.
   * Returns an empty array when nothing is pending. The orchestrator calls
   * this once per iteration, so a drained-and-empty session costs one Map miss.
   */
  public drain(sessionId: string): string[] {
    const queue = this.queues.get(sessionId);
    if (!queue || queue.length === 0) return [];
    this.queues.delete(sessionId);
    return queue;
  }

  /** True if `sessionId` has prompts waiting (diagnostics / tests). */
  public hasPending(sessionId: string): boolean {
    const queue = this.queues.get(sessionId);
    return queue !== undefined && queue.length > 0;
  }
}
