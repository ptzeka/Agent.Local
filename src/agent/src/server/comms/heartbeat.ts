import type { ILogger } from "@agent-local/common";

// a task run on every heartbeat tick. Receives the root signal so a long task can bail when the process aborts.
export type HeartbeatTask = (signal: AbortSignal) => void | Promise<void>;

// process-level periodic ticker: one timer fans out to every registered task on a fixed interval. Tasks are
// independent — one throwing is logged and swallowed so the timer (and the other tasks) keep running.
// Stops on the root signal so process shutdown clears it; for now its only task is reaping orphan SSE.
export class Heartbeat {
  private timer?: ReturnType<typeof setInterval>;
  private readonly tasks: HeartbeatTask[] = [];

  constructor(
    private readonly intervalMs: number,
    private readonly signal: AbortSignal,
    private readonly logger: ILogger,
  ) {}

  // chainable so wiring reads as a single statement in index.ts
  register(task: HeartbeatTask): this {
    this.tasks.push(task);
    return this;
  }

  start(): void {
    if (this.timer || this.signal.aborted) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    // a timer alone would keep the process alive; the heartbeat is ambient, so it must not block shutdown
    this.timer.unref?.();
    this.signal.addEventListener("abort", () => this.stop(), { once: true });
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private async tick(): Promise<void> {
    for (const task of this.tasks) {
      try {
        await task(this.signal);
      } catch (err) {
        this.logger.error?.("[agent-server] heartbeat task failed", err);
      }
    }
  }
}
