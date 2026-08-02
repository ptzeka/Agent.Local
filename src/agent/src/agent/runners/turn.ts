import type { ToolDescriptor } from "@agent-local/mcp";
import { Eventing } from "@agent-local/common/eventing";
import type { Conversation } from "../conversation/conversation.js";
import type { ChatMessage, LLMProvider, ToolCall } from "../providers/provider.js";
import type { ModelsFile } from "../registries/configuration-registry.js";
import { ScopedToolClient } from "../scoped-tool-client.js";
import { DispatchTracker } from "../synthetic-mcp/dispatch-tracker.js";
import type { ReportedTurnResult, TurnBindable, TurnBinding } from "../synthetic-mcp/types.js";
import { TurnResultCapture } from "../synthetic-mcp/turn-result-tools.js";
import type { RunResult } from "./turn-loop.js";
import { OrchestratorEventTypes } from "./runner-events.js";
import type { RunnerContext } from "./middleware/runner-middleware.js";
import { resolveTurnProfile, type TurnProfile } from "./turn-profile.js";
import { randomUUID } from "node:crypto";

// everything a turn is born with; the orchestrator assembles it once, the Turn exposes it read-only
export interface TurnOptions {
  profile: TurnProfile;
  provider: LLMProvider;
  scopedClients: ScopedToolClient;
  visibleTools: ToolDescriptor[];
  tracker: DispatchTracker;
  resultSink: TurnResultCapture;
  conversation: Conversation;
  config: ModelsFile;
  streaming: boolean;
}

// one prompt's turn: owns the per-turn state, the transcript writes, and the settled results
// the orchestrator owns the loop; a Turn never drives control flow, it only records and settles
// transcript invariant: append() persists, injectTransient() does not; only this class touches Conversation
export class Turn {
  readonly id: string;
  readonly profile: TurnProfile;
  readonly provider: LLMProvider;
  readonly scopedClients: ScopedToolClient;
  readonly visibleTools: ToolDescriptor[];
  readonly tracker: DispatchTracker;
  readonly resultSink: TurnResultCapture;
  readonly config: ModelsFile;
  readonly streaming: boolean;
  readonly workingMessages: ChatMessage[] = [];

  turnRequest: string | null = null;
  // tool evidence for the whole turn: a reply claiming work with this at zero only narrated
  toolCallsMade = 0;
  chatStarted = false;
  // the orchestrator's loop counter, stamped each pass; read for the iterations accounting
  iteration = 0;

  private readonly ctx: RunnerContext;
  private readonly conversation: Conversation;
  // installed by the context provider at turn start; empty until then, so seedOpeningSet stays valid
  private contextMessages: ChatMessage[] = [];
  // where the turn's first drained message lands, so the evaluator sees the request onward;
  // recomputed whenever the context prefix or a compaction reseeds the opening set
  private turnStartIndex = 0;

  constructor(ctx: RunnerContext, options: TurnOptions) {
    this.id = randomUUID().toString();
    this.ctx = ctx;
    this.profile = options.profile;
    this.provider = options.provider;
    this.scopedClients = options.scopedClients;
    this.visibleTools = options.visibleTools;
    this.tracker = options.tracker;
    this.resultSink = options.resultSink;
    this.conversation = options.conversation;
    this.config = options.config;
    this.streaming = options.streaming;
    this.seedOpeningSet();
  }

  // ---------------------------------------------------------------------------
  // Assembly
  // ---------------------------------------------------------------------------

  // resolves the profile, mounts the role's tools, and binds the per-turn seam before any work runs;
  // assembly lives here rather than in the loop so TurnLoop holds control flow only
  static async open(ctx: RunnerContext, role: string): Promise<Turn> {
    const modelsRegistry = ctx.runtime.getModelsRegistry();
    const mcpRegistry = ctx.runtime.getMcpClientRegistry();
    const config = await ctx.runtime.getConfigurationRegistry().getModelsConfiguration();

    const provider = ctx.runtime
      .getProvidersRegistry()
      .getProvider(modelsRegistry.getProviderForRole(role));

    const profile = resolveTurnProfile({ role, config, modelsRegistry });

    const scopedClients = ScopedToolClient.forRole(mcpRegistry, modelsRegistry, role);
    const visibleTools = scopedClients.listTools();
    const tracker = new DispatchTracker(
      config.orchestration.maxExecutorDispatchesPerTurn!,
      config.orchestration.validatorCheckIntervalDispatches ?? 0
    );
    // minted regardless so the post-tool check is uniform; only a bound server can ever fill it
    const resultSink = new TurnResultCapture();

    if (profile.needsTurnBinding) {
      bindTurnScopedServers(ctx, mcpRegistry.listClients(), tracker, resultSink);
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

  // a request already answered: return the recorded outcome without assembling a turn, so a replay
  // costs zero model calls and zero tool calls. Nothing is appended — the transcript already has the work
  static replayOf(executed: { outcome: RunResult["outcome"]; finalContent: string }): RunResult {
    return {
      finalMessage: { role: "assistant", content: executed.finalContent },
      iterations: 0,
      dispatches: 0,
      outcome: executed.outcome,
    };
  }

  // a wake whose inbox was already drained: nothing ran, so no turn is assembled and none is counted
  static idle(): RunResult {
    return {
      finalMessage: { role: "assistant", content: "" },
      iterations: 0,
      dispatches: 0,
      outcome: "satisfied",
    };
  }

  // ---------------------------------------------------------------------------
  // Transcript
  // ---------------------------------------------------------------------------

  // the one dual-write: persisted transcript and the model's working set stay in step
  append(...messages: ChatMessage[]): void {
    this.conversation.append(...messages);
    this.workingMessages.push(...messages);
  }

  // working set only — rebuilt each turn (like the request anchor), so persisting would bloat the record
  injectTransient(message: ChatMessage): void {
    this.workingMessages.push(message);
  }

  // installs the turn-start context prefix and reseeds the opening set from it; valid only before
  // this turn appends its own work, which is why the prologue runs it ahead of the request drain
  setContextMessages(messages: ChatMessage[]): void {
    this.contextMessages = messages;
    this.seedOpeningSet();
  }

  // the live persisted history the turn seeds from; the compaction policy reads it to decide
  history(): readonly ChatMessage[] {
    return this.conversation.getMessages();
  }

  // compaction is the one conversation-level rewrite: swap the persisted history for the compacted
  // set, then reseed the opening working set from it — valid only before this turn appends its own work
  async replaceHistory(messages: ChatMessage[]): Promise<void> {
    await this.conversation.replaceAll(messages);
    this.seedOpeningSet();
  }

  // (re)builds the opening working set as the context prefix + the live conversation, and marks where
  // this turn's own work begins so transcriptOfTurn() and the evaluator see the request onward
  private seedOpeningSet(): void {
    this.workingMessages.length = 0;
    this.workingMessages.push(...this.contextMessages, ...this.conversation.getMessages());
    this.turnStartIndex = this.workingMessages.length;
  }

  // flushed immediately so a crash before the next model call keeps the steering on record
  async nudge(content: string): Promise<void> {
    this.append({ role: "user", content });
    await this.flush();
  }

  flush(): Promise<void> {
    return this.conversation.flush();
  }

  // this turn's work only — what the evaluator judges, excluding prompt and prior transcript
  transcriptOfTurn(): ChatMessage[] {
    return this.workingMessages.slice(this.turnStartIndex);
  }

  // ---------------------------------------------------------------------------
  // Tool round
  // ---------------------------------------------------------------------------

  // one iteration's tool calls, run CONCURRENTLY: a model emitting several calls in one reply asserts they
  // are independent, and the round itself is the join — every result is paired before the next model call,
  // so no call outlives the turn that issued it
  // returns the landed report_result when the mandated terminal call fired; the loop decides what that means
  async runToolCalls(calls: ToolCall[]): Promise<ReportedTurnResult | null> {
    if (this.ctx.signal.aborted) {
      throw new Error("turn aborted: user requested stop");
    }
    this.toolCallsMade += calls.length;

    // the scoped client degrades every failure to an isError result, so only a user abort escapes this gather
    const executions = await Promise.all(
      calls.map(async (call) => {
        this.ctx.logger.debug("tool call start", { name: call.name });
        const execution = await this.scopedClients.callTool(
          call.name,
          call.arguments,
          this.ctx.events,
          this.ctx.signal
        );
        this.ctx.logger.debug("tool call end", { name: call.name, isError: execution.isError });
        return execution;
      })
    );

    // index-aligned with `calls`, so the transcript keeps the model's own ordering whatever order they settled in
    this.append(
      ...executions.map((execution, index) =>
        toolResultMessage(
          calls[index],
          execution.isError ? `[tool-error] ${execution.content}` : execution.content
        )
      )
    );

    // the reporting path flushes with its own envelope, so only the continuing path persists here
    const reported = this.resultSink.value;
    if (reported) return reported;

    // persist this round so a crash mid-turn loses at most the round in flight
    await this.flush();
    return null;
  }

  // ---------------------------------------------------------------------------
  // Results
  // ---------------------------------------------------------------------------

  settle(finalMessage: ChatMessage, outcome: "satisfied" | "awaiting-input"): RunResult {
    return {
      finalMessage,
      iterations: this.iteration,
      dispatches: this.tracker.count,
      outcome,
    };
  }

  // ends the turn on a token ceiling. NOT a failure and NOT a user cancel: the work was stopped by policy,
  // so the notice goes on record and the outcome is its own tag the host can price rather than debug
  async budgetCapped(detail: string): Promise<RunResult> {
    const notice: ChatMessage = {
      role: "assistant",
      content: `ORCHESTRATOR: stopped — ${detail}. Raise maxTokensPerTurn/maxTokensPerSession in models.json or narrow the request.`,
    };
    this.conversation.append(notice);
    await this.flush();
    return {
      finalMessage: notice,
      iterations: this.iteration,
      dispatches: this.tracker.count,
      outcome: "budget-capped",
    };
  }

  // records a system-failure notice and ends the turn "failed" so the loop stops trying
  async fail(reason: string): Promise<RunResult> {
    const failureNotice: ChatMessage = {
      role: "assistant",
      content: `SYSTEM-FAILURE: failed to complete request — ${reason}`,
    };
    this.conversation.append(failureNotice);
    this.ctx.events.publish(OrchestratorEventTypes.SYSTEM_FAILURE, { reason });
    await this.flush();
    return {
      finalMessage: failureNotice,
      iterations: this.iteration,
      dispatches: this.tracker.count,
      outcome: "failed",
    };
  }

  // ends a dispatched turn on the agent's report_result: the final conversation line IS the verdict envelope
  // (single JSON line) so the record is self-describing, and outcome mirrors status so the step gate
  // fails closed on a "fail" verdict without parsing prose
  async finalizeReported(reported: ReportedTurnResult): Promise<RunResult> {
    const envelope = { status: reported.status, input: this.turnRequest, result: reported.result };
    const finalMessage: ChatMessage = { role: "assistant", content: JSON.stringify(envelope) };
    this.conversation.append(finalMessage);
    this.ctx.events.publish(OrchestratorEventTypes.MESSAGE, {
      iteration: this.iteration,
      content: finalMessage.content,
      toolCallCount: 0,
    });
    await this.flush();
    return {
      finalMessage,
      iterations: this.iteration,
      dispatches: this.tracker.count,
      outcome: reported.status === "success" ? "satisfied" : "failed",
      reported,
    };
  }
}

// pure mapper: a tool execution into the transcript's tool message shape
function toolResultMessage(call: ToolCall, content: string): ChatMessage {
  return {
    role: "tool",
    content,
    toolCallId: call.id,
    toolName: call.name,
  };
}

// ---------------------------------------------------------------------------
// Turn-scoped server binding
// ---------------------------------------------------------------------------

// ONE per-turn seam: servers register once at build; those holding turn state take it here
function bindTurnScopedServers(
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

// narrows without the double cast: a client only takes the turn seam if it actually implements it
function isTurnBindable(client: unknown): client is TurnBindable {
  return typeof (client as Partial<TurnBindable>)?.bindTurn === "function";
}
