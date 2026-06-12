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
 */
export class InputInbox {
  private readonly queues = new Map<string, string[]>();

  /** Enqueue a prompt for `sessionId`. The `source` tag is reserved for future
   *  provenance (e.g. "api", "parent"); unused today but kept in the signature
   *  so producers can start passing it without a later breaking change. */
  public push(sessionId: string, content: string, _source?: string): void {
    const trimmed = content.trim();
    if (trimmed.length === 0) return;
    const queue = this.queues.get(sessionId);
    if (queue) {
      queue.push(trimmed);
    } else {
      this.queues.set(sessionId, [trimmed]);
    }
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
