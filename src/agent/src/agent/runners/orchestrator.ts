import { ScopedToolClient } from "../scoped-tool-client.js";
import type { ChatMessage } from "../providers/provider.js";
import { DispatchTracker } from "../synthetic-mcp/dispatch-tracker.js";
import type { TurnBindable, TurnBinding } from "../synthetic-mcp/types.js";
import { TURN_RESULT_SERVER_NAME } from "../synthetic-mcp/turn-result-server.js";
import { TurnResultCapture } from "../synthetic-mcp/turn-result-tools.js";
import type { ReportedTurnResult } from "../synthetic-mcp/types.js";
import type { RunnerContext } from "./middleware/runner-middleware.js";
import { Eventing } from "@agent-local/common/eventing";
import { Turn } from "./turn.js";
import { ModelCaller } from "./model-caller.js";
import { ToolCaller } from "./tool-caller.js";
import { resolveTurnProfile } from "./turn-profile.js";
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
  // "capped" hit the iteration bound, "failed" judged unrecoverable; drives the headless exit code
  outcome: "satisfied" | "awaiting-input" | "capped" | "failed";
  // the agent's structured verdict from report_result on a dispatched turn; absent when the tool wasn't mounted
  // or wasn't called (interactive, capped, or system-failed turns) — the dispatch boundary fills a fallback then
  reported?: ReportedTurnResult;
}

// narrow contract satisfied structurally by Orchestrator, so the manager stays decoupled and construction acyclic
export interface SessionRunner {
  run(ctx: RunnerContext): Promise<RunResult>;
}

// the four extension slots; anything omitted falls back to the built-in default
// contributors are additive and unbounded, the other three are singular because they decide
export interface OrchestratorPolicies {
  contextProvider?: ContextProvider;
  compaction?: CompactionPolicy;
  contributors?: readonly ContextContributor[];
  // overrides the profile's own selection for every role; normally left unset
  completion?: CompletionPolicy;
}

// drives the agentic loop for any role; the profile carries every per-role difference as data
// STATELESS: holds only its role and its policy slots; per-turn state lives in the Turn
export class Orchestrator {
  private readonly contextProvider: ContextProvider;
  private readonly compaction: CompactionPolicy;
  private readonly contributors: readonly ContextContributor[];
  private readonly completionOverride?: CompletionPolicy;

  // the loop's own steps, not extension points: they gather data, they never end a turn
  private readonly model = new ModelCaller();
  private readonly tools = new ToolCaller();

  constructor(private readonly role: string, policies: OrchestratorPolicies = {}) {
    this.contextProvider = policies.contextProvider ?? new SnapshotContextProvider();
    this.compaction = policies.compaction ?? new SummarizeCompaction();
    this.contributors = policies.contributors ?? [new MemoryContributor()];
    this.completionOverride = policies.completion;
  }

  // runs one user turn end-to-end: a prologue that runs once, then the iteration loop.
  // the loop persists per iteration so a crash loses at most the iteration in flight,
  // with the runtime's finalize() backstopping the tail
  public async run(ctx: RunnerContext): Promise<RunResult> {
    const turn = await this.openTurn(ctx);

    // cold wake: the inbox was already drained by the turn that woke with it, so settle
    // before paying for context assembly or compaction — nothing would consume them
    if (!ctx.hasPending?.()) {
      ctx.logger.debug("empty turn — no queued input, settling without model call", {
        sessionId: ctx.session.sessionId,
      });
      return turn.idle();
    }

    await this.runPrologue(turn, ctx);

    const completion = this.completionOverride ?? selectCompletionPolicy(turn.profile);
    const maxIterations = turn.profile.maxIterations;

    for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
      if (ctx.signal.aborted) {
        throw new Error("turn aborted: user requested stop");
      }
      turn.iteration = iteration;
      ctx.events.publish(OrchestratorEventTypes.ITERATION, { iteration, max: maxIterations });

      const reply = await this.model.call(turn, ctx);

      if (reply.toolCalls.length > 0) {
        // report_result is the mandated terminal action on a dispatched turn: once it lands, end with the
        // structured verdict — its status drives the outcome, so a "fail" verdict fails the step even though
        // the agent answered honestly (a true-but-negative answer must not bank as satisfied)
        const reported = await this.tools.run(turn, ctx, reply.toolCalls);
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
  // Turn setup
  // ---------------------------------------------------------------------------

  // resolves the profile, mounts the role's tools, and binds the per-turn seam before any work runs
  private async openTurn(ctx: RunnerContext): Promise<Turn> {
    const modelsRegistry = ctx.runtime.getModelsRegistry();
    const mcpRegistry = ctx.runtime.getMcpClientRegistry();
    const config = await ctx.runtime.getConfigurationRegistry().getModelsConfiguration()!;

    const provider = ctx.runtime
      .getProvidersRegistry()
      .getProvider(modelsRegistry.getProviderForRole(this.role));

    const profile = resolveTurnProfile({
      role: this.role,
      config,
      modelsRegistry,
      structuredAvailable: !!mcpRegistry.getClient(TURN_RESULT_SERVER_NAME),
    });

    const scopedClients = ScopedToolClient.forRole(mcpRegistry, modelsRegistry, this.role);
    const visibleTools = scopedClients.listTools();
    const tracker = new DispatchTracker(
      config.orchestration.maxExecutorDispatchesPerTurn!,
      config.orchestration.validatorCheckIntervalDispatches ?? 0
    );
    // minted regardless so the post-tool check is uniform; only a bound server can ever fill it
    const resultSink = new TurnResultCapture();

    if (profile.needsTurnBinding) {
      this.bindTurnScopedServers(ctx, mcpRegistry.listClients(), tracker, resultSink);
    }

    ctx.events.publish(OrchestratorEventTypes.START, {
      orchestratorModel: provider.modelId,
      orchestratorTools: visibleTools,
      readToolCount: visibleTools.length,
      maxIterations: profile.maxIterations,
    });

    return new Turn(ctx, {
      profile,
      provider,
      scopedClients,
      visibleTools,
      tracker,
      resultSink,
      conversation: ctx.runtime.getConversation(),
      config,
      streaming: ctx.runtime.isStreamOutputEnabled(),
    });
  }

  // ONE per-turn seam: servers register once at build; those holding turn state take it here
  private bindTurnScopedServers(
    ctx: RunnerContext,
    clients: readonly unknown[],
    tracker: DispatchTracker,
    resultSink: TurnResultCapture
  ): void {
    // chained under the turn so what bound servers publish bubbles up
    const mcpClientEvents = new Eventing();
    ctx.events.add(mcpClientEvents);
    const binding: TurnBinding = { signal: ctx.signal, tracker, events: mcpClientEvents, resultSink };
    for (const client of clients) {
      if (isTurnBindable(client)) client.bindTurn(binding);
    }
  }

  // ---------------------------------------------------------------------------
  // Prologue — runs ONCE per turn, ahead of the iteration loop
  // ---------------------------------------------------------------------------

  // order is load-bearing: context and compaction must both land before the request is appended,
  // and contributors run last because they key off the drained request
  private async runPrologue(turn: Turn, ctx: RunnerContext): Promise<void> {
    turn.setContextMessages(await this.contextProvider.build(turn, ctx));
    await this.compaction.applyIfNeeded(turn, ctx);
    this.drainRequest(turn, ctx);
    for (const contributor of this.contributors) {
      await contributor.contribute(turn, ctx);
    }
  }

  // ONE prompt per turn: the request carries across every iteration, so a prompt queued mid-turn
  // is left for the pump to replay as the next turn
  private drainRequest(turn: Turn, ctx: RunnerContext): void {
    const request = ctx.pullInjectedPrompt?.() ?? "";
    turn.append({ role: "user", content: request });
    turn.turnRequest = request;
    ctx.events.publish(OrchestratorEventTypes.INJECTED_INPUT, { turnId: turn.id, content: request });
    ctx.logger.debug("turn input drained", { turnId: turn.id, hasRequest: request.length > 0 });
  }

  // ---------------------------------------------------------------------------
  // Cap
  // ---------------------------------------------------------------------------

  private capped(turn: Turn, ctx: RunnerContext, maxIterations: number): RunResult {
    const truncationNotice: ChatMessage = {
      role: "assistant",
      content:
        `ORCHESTRATOR: hit iteration cap of ${maxIterations} without a final answer. ` +
        "Try a narrower request or raise maxOrchestratorIterations in models.json.",
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

// narrows without the double cast: a client only takes the turn seam if it actually implements it
function isTurnBindable(client: unknown): client is TurnBindable {
  return typeof (client as Partial<TurnBindable>)?.bindTurn === "function";
}
