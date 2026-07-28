import { Eventing, type ILogger } from "@agent-local/common";
import type { RunResult } from "../../agent/runners/turn-loop.js";
import {
  EXECUTION_REQUESTED,
  EXECUTION_RESULT,
  EXECUTION_CANCEL,
  EXECUTION_INTERRUPT,
  type ExecutionCancel,
  type ExecutionInterrupt,
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
    // user pressed Stop in the live chat: cancel that live session's in-flight turn but keep the runtime up, so the
    // chat stays usable. Only the live (SSE) path applies — a one-shot job has no interactive Stop.
    this.bus.subscribe(EXECUTION_INTERRUPT, (event) => {
      const { sessionId } = event.payload as unknown as ExecutionInterrupt;
      const live = this.sseQueue.get(sessionId);
      if (!live) return;
      live.runtime.stopAllWork();
      this.logger.debug?.(`[agent-server] interrupted live turn for session ${sessionId}`);
    });
  }

  // periodic sweep (driven by the process Heartbeat): a dead SSE whose 'close' never fired — a tab the OS/proxy
  // dropped without propagating the disconnect — holds the session's single live slot and leaks its runtime,
  // 409-ing the real user out forever. Reap any connection whose response is no longer writable: deregister and
  // drain it the same way ssereceiver's own teardown does, freeing the slot. Live-but-idle streams are untouched.
  heartbeat(): void {
    for (const connection of this.sseQueue.values()) {
      const res = connection.res;
      const dead = res.writableEnded || res.destroyed || res.socket?.destroyed === true;
      if (!dead) continue;
      this.sseQueue.deregister(connection.sessionId, connection);
      void connection.runtime
        .stopTurnLoop()
        .then(() => connection.runtime.shutdown({ mode: "drain", timeoutMs: 10_000 }))
        .catch((err) => this.logger.error?.("[agent-server] orphan sse teardown failed", err));
      this.logger.debug?.(`[agent-server] reaped orphan sse for session ${connection.sessionId}`);
    }
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
        accessToken: requested.accessToken,
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
    } catch (err) {
      // only an expected, completed turn counts as success — a thrown turn (build failure, provider 5xx, a capped
      // run) is a real verdict and must bubble up as a fail ENVELOPE, not be swallowed. Without this the host never
      // gets agent.result, the workflow blocks forever on a signal that will never arrive, and the step session
      // leaks. Carve-out: a deliberate cancel (EXECUTION_CANCEL aborts the run on host Stop/pause) is meant to drop
      // the answer so the workflow re-dispatches on resume — publish nothing there, or it would fail a paused step.
      if (signal.aborted) {
        this.logger.debug?.(`[agent-server] run for session ${requested.sessionId} aborted; answer dropped`);
        return;
      }
      this.logger.error?.("[agent-server] run failed; reporting fail verdict", err);
      this.bus.publish(EXECUTION_RESULT, {
        sessionId: requested.sessionId,
        runId: requested.runId,
        source: requested.source,
        createdAt: requested.createdAt,
        result: { status: "fail", input: requested.input, result: { error: String(err) } },
        outcome: "failed",
      } satisfies ExecutionResult);
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
