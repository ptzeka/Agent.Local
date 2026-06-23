import { Eventing, type ILogger } from "@agent-local/common";
import type { RunResult } from "../../agent/runners/orchestrator.js";
import {
  EXECUTION_REQUESTED,
  EXECUTION_RESULT,
  EXECUTION_CANCEL,
  type ExecutionCancel,
  type ExecutionRequested,
  type ExecutionResult,
  type TurnResponse,
} from "./contract.js";
import type { RuntimeBuilder } from "./runtime-builder.js";
import type { SseQueue } from "./sse-queue.js";

// the execution worker, off the transport. It subscribes to the receiver's internal event and owns input routing:
// a live SSE session has a persistent runtime (one per connection) — input is injected into it and its event
// stream carries the answer out. Otherwise it is a one-shot job — build a runtime bound to the request's session,
// run ONE turn, publish the result for the webhook sender, then drain it. Construction lives in RuntimeBuilder.
export class ExecutionRunner {
  // process-level deps every run shares: the root signal each one-shot turn cancels on, the shared runtime
  // builder, the live-connection registry (the SSE discriminator), the logger, and the process bus.
  // per-session cancel handles for in-flight one-shot runs; a /session/close aborts the matching run by id
  private readonly activeRuns = new Map<string, AbortController>();

  constructor(
    private readonly signal: AbortSignal,
    private readonly builder: RuntimeBuilder,
    private readonly sseQueue: SseQueue,
    private readonly logger: ILogger,
    private readonly bus: Eventing,
  ) {}

  // bus binding: every queued request is routed to its live session or run as a one-shot job
  start(): void {
    this.bus.subscribe(EXECUTION_REQUESTED, (event) => {
      void this.run(event.payload as unknown as ExecutionRequested).catch((err) =>
        this.logger.error?.("[agent-server] run failed", err),
      );
    });
    // host closed the session (Stop/pause): abort that session's in-flight run so the whole executor subtree
    // collapses off the shared signal — the answer never lands, which the workflow re-dispatches on resume
    this.bus.subscribe(EXECUTION_CANCEL, (event) => {
      const { sessionId } = event.payload as unknown as ExecutionCancel;
      const controller = this.activeRuns.get(sessionId);
      if (!controller) return;
      controller.abort("session-closed");
      this.logger.debug?.(`[agent-server] aborted in-flight run for session ${sessionId}`);
    });
  }

  private async run(requested: ExecutionRequested): Promise<void> {
    // a live SSE session owns a persistent runtime; route input into it and let its event stream carry the answer
    // out over the connection. No build, no drain, no webhook — the SSE connection IS the sink.
    const live = this.sseQueue.get(requested.sessionId);
    if (live) {
      live.runtime.injectInput(requested.input, "user");
      return;
    }

    // per-run cancel handle: any-ed with root so process shutdown still cancels, and registered by session so a
    // /session/close aborts THIS run. cleared in the outer finally even if the build throws, so no handle leaks.
    const controller = new AbortController();
    const signal = AbortSignal.any([this.signal, controller.signal]);
    this.activeRuns.set(requested.sessionId, controller);
    try {
      // one-shot job: build a runtime for this turn under the workflow-orchestrator role (mounts report_result → the
      // turn answers with a structured envelope), on the process bus; run it, publish the result for the sender, then
      // drain so the session flushes to disk and MCP clients close.
      const runtime = await this.builder.build(requested.sessionId, {
        orchestratorRole: "workflow-orchestrator",
        eventing: this.bus,
      });
      try {
        const result = await runtime.dispatchAsync(requested.input, { signal });
        const answer: ExecutionResult = {
          sessionId: requested.sessionId,
          runId: requested.runId,
          source: requested.source,
          createdAt: requested.createdAt,
          result: this.toEnvelope(requested.input, result),
          outcome: result.outcome,
        };
        this.bus.publish(EXECUTION_RESULT, { ...answer });
      } finally {
        await runtime
          .shutdown({ mode: "drain", timeoutMs: 30_000 })
          .catch((err) => this.logger.error?.("[agent-server] runtime close failed", err));
      }
    } finally {
      // only clear our own handle: a later run for the same session may have already replaced it
      if (this.activeRuns.get(requested.sessionId) === controller) this.activeRuns.delete(requested.sessionId);
    }
  }

  // shapes the finished turn into the common response envelope. A turn that called report_result carries its
  // structured verdict through; one that didn't (capped, system-failed, or a model that skipped the tool) gets a
  // fallback derived from the loop outcome — fail unless the loop itself settled satisfied, so doubt fails closed.
  private toEnvelope(input: string, result: RunResult): TurnResponse {
    if (result.reported) {
      return { status: result.reported.status, input, result: result.reported.result };
    }
    return {
      status: result.outcome === "satisfied" ? "success" : "fail",
      input,
      result: { message: result.finalMessage.content, outcome: result.outcome },
    };
  }
}
