import type { ChatMessage } from "../providers/provider.js";
import type { ReportedTurnResult } from "../synthetic-mcp/types.js";
import type { InboxItem } from "./input-inbox.js";
import type { RunnerContext } from "./middleware/runner-middleware.js";
import { Turn } from "./turn.js";
import { ModelCaller } from "./model-caller.js";
import { runEvaluatorPass, type EvaluationState, EVALUATOR_SERVER_NAME } from "./evaluator-pass.js";
import { budgetCancelDetail } from "./policies/budget.js";
import { selectCompletionPolicy } from "./policies/completion.js";
import { MemoryContributor } from "./policies/memory-contributor.js";
import { SnapshotContextProvider } from "./policies/snapshot-context-provider.js";
import { SummarizeCompaction } from "./policies/summarize-compaction.js";
import type {
  CompactionPolicy,
  CompletionPolicy,
  ContextContributor,
  ContextProvider,
} from "./policies/types.js";
import { OrchestratorEventTypes } from "./runner-events.js";

// re-export for backwards compatibility
export type { OrchestratorEvent, OrchestratorListener } from "./runner-events.js";

export interface RunResult {
  finalMessage: ChatMessage;
  iterations: number;
  dispatches: number;
  // "satisfied" accepted, "awaiting-input" ended on a clarification question (no work done — distinct so headless can't read it as success),
  // "capped" hit the iteration bound, "budget-capped" hit a token ceiling, "failed" judged unrecoverable; drives the headless exit code
  outcome: "satisfied" | "awaiting-input" | "capped" | "budget-capped" | "failed";
  // the agent's structured verdict from report_result on a dispatched turn; absent when the tool wasn't mounted
  // or wasn't called (interactive, capped, or system-failed turns) — the dispatch boundary fills a fallback then
  reported?: ReportedTurnResult;
  // the terminal evaluator pass's independent judgement, stamped into the conversation; absent when the pass
  // is disabled for the role or skipped (trivially short request). Distinct from `outcome`, which the loop sets
  evaluation?: { status: EvaluationState; reason: string };
}

// narrow contract satisfied structurally by TurnLoop, so the manager stays decoupled and construction acyclic
export interface SessionRunner {
  run(ctx: RunnerContext): Promise<RunResult>;
}

// the four extension slots; anything omitted falls back to the built-in default
// contributors are additive and unbounded, the other three are singular because they decide
export interface TurnPolicies {
  contextProvider?: ContextProvider;
  compaction?: CompactionPolicy;
  contributors?: readonly ContextContributor[];
  // overrides the profile's own selection for every role; normally left unset
  completion?: CompletionPolicy;
}

// drives the agentic loop for any role; the profile carries every per-role difference as data
// STATELESS: holds only its role and its policy slots; per-turn state and assembly live in the Turn
export class TurnLoop implements SessionRunner {
  private readonly contextProvider: ContextProvider;
  private readonly compaction: CompactionPolicy;
  private readonly contributors: readonly ContextContributor[];
  private readonly completionOverride?: CompletionPolicy;

  // the loop's own step, not an extension point: it gathers data, it never ends a turn
  private readonly model = new ModelCaller();

  constructor(private readonly role: string, policies: TurnPolicies = {}) {
    this.contextProvider = policies.contextProvider ?? new SnapshotContextProvider();
    this.compaction = policies.compaction ?? new SummarizeCompaction();
    this.contributors = policies.contributors ?? [new MemoryContributor()];
    this.completionOverride = policies.completion;
  }

  // runs one user turn end-to-end: a prologue that runs once, then the iteration loop.
  // the loop persists per iteration so a crash loses at most the iteration in flight,
  // with the runtime's finalize() backstopping the tail
  public async run(ctx: RunnerContext): Promise<RunResult> {
    // cold wake: the inbox was already drained by the turn that woke with it, so settle before
    // assembling anything — mounting tools and binding servers would all be discarded
    if (!ctx.hasPending?.()) {
      ctx.logger.debug("empty turn — no queued input, settling without model call", {
        sessionId: ctx.session.sessionId,
      });
      return Turn.idle();
    }

    // popped BEFORE assembly so a replay costs no tool mount and no model call; the request is only
    // APPENDED later, inside the prologue, where the context/compaction order still governs
    const request = ctx.pullInjectedPrompt?.() ?? null;
    if (!request) return Turn.idle();

    const executed = ctx.executedRecord?.(request) ?? null;
    if (executed) {
      ctx.logger.debug("duplicate request — answering from the executed ledger", {
        sessionId: ctx.session.sessionId,
        turnId: executed.turnId,
      });
      return Turn.replayOf(executed);
    }

    const turn = await Turn.open(ctx, this.role);
    await this.runPrologue(turn, ctx, request);

    // a ceiling breach cancels the turn's cutoff, so it can surface as the abort check below OR as a
    // throw from whatever await was in flight (model call, tool call) — one catch covers every source
    let result: RunResult;
    try {
      result = await this.iterate(turn, ctx);
    } catch (err) {
      const detail = budgetCancelDetail(ctx.signal);
      if (detail === null) throw err;
      return this.remember(ctx, request, turn, await turn.budgetCapped(detail));
    }

    // out of budget: the epilogue is another model call, which is exactly what the ceiling forbids
    if (result.outcome === "budget-capped") return this.remember(ctx, request, turn, result);

    await this.runEpilogue(turn, ctx, result);
    return this.remember(ctx, request, turn, result);
  }

  // one exit point for the ledger write, so no settle path can forget it
  private remember(
    ctx: RunnerContext,
    request: InboxItem,
    turn: Turn,
    result: RunResult
  ): RunResult {
    ctx.recordExecuted?.(request, {
      turnId: turn.id,
      outcome: result.outcome,
      finalContent: result.finalMessage.content,
      finishedAt: Date.now(),
    });
    return result;
  }

  // ---------------------------------------------------------------------------
  // Iteration loop
  // ---------------------------------------------------------------------------

  private async iterate(turn: Turn, ctx: RunnerContext): Promise<RunResult> {
    const completion = this.completionOverride ?? selectCompletionPolicy(turn.profile);
    const maxIterations = turn.profile.maxIterations;

    for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
      if (ctx.signal.aborted) {
        // a budget stop is a deterministic END, not an abandoned turn: settle it rather than throwing
        const detail = budgetCancelDetail(ctx.signal);
        if (detail !== null) return turn.budgetCapped(detail);
        throw new Error("turn aborted: user requested stop");
      }
      turn.iteration = iteration;
      ctx.events.publish(OrchestratorEventTypes.ITERATION, { iteration, max: maxIterations });

      const reply = await this.model.call(turn, ctx);

      if (reply.toolCalls.length > 0) {
        // report_result is the mandated terminal action on a dispatched turn: once it lands, end with the
        // structured verdict — its status drives the outcome, so a "fail" verdict fails the step even though
        // the agent answered honestly (a true-but-negative answer must not bank as satisfied)
        const reported = await turn.runToolCalls(reply.toolCalls);
        if (reported) return turn.finalizeReported(reported);
        continue;
      }

      const verdict = await completion.judge(turn, reply.assistantMessage, ctx);
      if (verdict.kind === "settle") return turn.settle(reply.assistantMessage, verdict.outcome);
      if (verdict.kind === "fail") return turn.fail(verdict.reason);
      await turn.nudge(verdict.nudge);
    }

    return this.capped(turn, ctx, maxIterations);
  }

  // ---------------------------------------------------------------------------
  // Epilogue — the terminal evaluator pass, runs ONCE after the turn settles
  // ---------------------------------------------------------------------------

  // a separate role reads this turn's transcript and stamps an independent PASS/FAIL/INCOMPLETE verdict into
  // the conversation; it never changes `outcome` (the loop already set that) — it only annotates and reports
  private async runEpilogue(turn: Turn, ctx: RunnerContext, result: RunResult): Promise<void> {
    if (!turn.profile.evaluatorPass) return;
    // the judge is a dispatch tool mounted for coordinators; absent it (evaluator role undefined) there is no pass
    const client = ctx.runtime.getMcpClientRegistry().getClient(EVALUATOR_SERVER_NAME);
    if (!client) return;

    const verdict = await runEvaluatorPass(
      ctx.runtime,
      client,
      {
        question: turn.turnRequest ?? "",
        proposedAnswer: result.finalMessage.content,
        transcript: turn.transcriptOfTurn(),
      },
      ctx.signal
    );
    result.evaluation = { status: verdict.state, reason: verdict.reason };
  }

  // ---------------------------------------------------------------------------
  // Prologue — runs ONCE per turn, ahead of the iteration loop
  // ---------------------------------------------------------------------------

  // order is load-bearing: context and compaction must both land before the request is appended,
  // and contributors run last because they key off the drained request
  private async runPrologue(turn: Turn, ctx: RunnerContext, request: InboxItem): Promise<void> {
    turn.setContextMessages(await this.contextProvider.build(turn, ctx));
    await this.compaction.applyIfNeeded(turn, ctx);
    this.anchorRequest(turn, ctx, request);
    for (const contributor of this.contributors) {
      await contributor.contribute(turn, ctx);
    }
  }

  // ONE prompt per turn: the request carries across every iteration, so a prompt queued mid-turn
  // is left for the pump to replay as the next turn
  private anchorRequest(turn: Turn, ctx: RunnerContext, request: InboxItem): void {
    turn.append({ role: "user", content: request.content });
    turn.turnRequest = request.content;
    ctx.events.publish(OrchestratorEventTypes.INJECTED_INPUT, {
      turnId: turn.id,
      content: request.content,
    });
    ctx.logger.debug("turn input anchored", {
      turnId: turn.id,
      hasRequest: request.content.length > 0,
    });
  }

  // ---------------------------------------------------------------------------
  // Cap
  // ---------------------------------------------------------------------------

  private capped(turn: Turn, ctx: RunnerContext, maxIterations: number): RunResult {
    const truncationNotice: ChatMessage = {
      role: "assistant",
      content:
        `ORCHESTRATOR: hit iteration cap of ${maxIterations} without a final answer. ` +
        `Try a narrower request or raise the "${turn.profile.role}" role's maxIterations in models.json.`,
    };
    turn.append(truncationNotice);
    ctx.events.publish(OrchestratorEventTypes.WARNING, {
      message: `${this.role} hit iteration cap`,
      iterations: maxIterations,
    });
    return {
      finalMessage: truncationNotice,
      iterations: maxIterations,
      dispatches: turn.tracker.count,
      outcome: "capped",
    };
  }
}
