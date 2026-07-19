import type { ToolDescriptor } from "@agent-local/mcp";
import type { Conversation } from "../../conversation/conversation.js";
import type { ChatMessage, LLMProvider, ToolCall } from "../../providers/provider.js";
import type { ModelsFile } from "../../registries/configuration-registry.js";
import type { ScopedToolClient } from "../../scoped-tool-client.js";
import type { DispatchTracker } from "../../synthetic-mcp/dispatch-tracker.js";
import type { ReportedTurnResult } from "../../synthetic-mcp/types.js";
import type { TurnResultCapture } from "../../synthetic-mcp/turn-result-tools.js";
import type { RunResult } from "../orchestrator.js";
import { OrchestratorEventTypes } from "../runner-events.js";
import type { IRound, RoundOutcome } from "./iround.js";
import type { RunnerContext } from "./runner-middleware.js";

// everything a turn is born with; the runner assembles it once, the Turn exposes it read-only
export interface TurnOptions {
  role: string;
  provider: LLMProvider;
  scopedClients: ScopedToolClient;
  visibleTools: ToolDescriptor[];
  tracker: DispatchTracker;
  resultSink: TurnResultCapture;
  conversation: Conversation;
  config: ModelsFile;
  structuredMode: boolean;
  temperature: number;
  streaming: boolean;
  maxIterations: number;
  // system prompt + prior transcript; the boundary between "context" and "this turn's work"
  openingMessages: ChatMessage[];
  rounds: readonly IRound[];
}

// one user turn as an object: owns the per-turn state, the transcript writes, the outcome
// envelopes, and the iteration loop that drives its rounds — the runner only constructs it
// transcript invariant: append() persists, injectTransient() does not; rounds never touch Conversation
export class Turn {
  readonly role: string;
  readonly provider: LLMProvider;
  readonly scopedClients: ScopedToolClient;
  readonly visibleTools: ToolDescriptor[];
  readonly tracker: DispatchTracker;
  readonly resultSink: TurnResultCapture;
  readonly config: ModelsFile;
  readonly structuredMode: boolean;
  readonly temperature: number;
  readonly streaming: boolean;
  readonly maxIterations: number;
  readonly workingMessages: ChatMessage[];

  turnRequest: string | null = null;
  recalled = false;
  toolCallsMade = 0;
  iteration = 0;
  chatStarted = false;
  // per-iteration handoff: ModelRound writes, the rounds below it read
  assistantMessage: ChatMessage | null = null;
  toolCalls: ToolCall[] = [];

  private readonly ctx: RunnerContext;
  private readonly conversation: Conversation;
  private readonly rounds: readonly IRound[];
  // where the turn's first drained message lands, so the evaluator sees the request onward
  private readonly turnStartIndex: number;

  constructor(ctx: RunnerContext, options: TurnOptions) {
    this.ctx = ctx;
    this.role = options.role;
    this.provider = options.provider;
    this.scopedClients = options.scopedClients;
    this.visibleTools = options.visibleTools;
    this.tracker = options.tracker;
    this.resultSink = options.resultSink;
    this.conversation = options.conversation;
    this.config = options.config;
    this.structuredMode = options.structuredMode;
    this.temperature = options.temperature;
    this.streaming = options.streaming;
    this.maxIterations = options.maxIterations;
    this.workingMessages = [...options.openingMessages];
    this.turnStartIndex = this.workingMessages.length;
    this.rounds = options.rounds;
  }

  // ---------------------------------------------------------------------------
  // Loop
  // ---------------------------------------------------------------------------

  // drives the round list per iteration and obeys each round's outcome; runs to the
  // cap only when no round ever ends the turn, which is itself a reportable outcome
  async runAsync(): Promise<RunResult> {
    for (let iteration = 1; iteration <= this.maxIterations; iteration += 1) {
      if (this.ctx.signal.aborted) {
        throw new Error("turn aborted: user requested stop");
      }
      this.iteration = iteration;

      for (const round of this.rounds) {
        const outcome = await round.runAsync(this);
        if (outcome.kind === "done") return outcome.result;
        if (outcome.kind === "next-iteration") break;
      }
    }

    const truncationNotice: ChatMessage = {
      role: "assistant",
      content:
        `ORCHESTRATOR: hit iteration cap of ${this.maxIterations} without a final answer. ` +
        "Try a narrower request or raise maxOrchestratorIterations in models.json.",
    };
    this.conversation.append(truncationNotice);
    this.ctx.events.publish(OrchestratorEventTypes.WARNING, {
      message: `${this.role} hit iteration cap`,
      iterations: this.maxIterations,
    });
    return {
      finalMessage: truncationNotice,
      iterations: this.maxIterations,
      dispatches: this.tracker.count,
      outcome: "capped",
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
  // Outcomes
  // ---------------------------------------------------------------------------

  settle(finalMessage: ChatMessage, outcome: "satisfied" | "awaiting-input"): RoundOutcome {
    return {
      kind: "done",
      result: {
        finalMessage,
        iterations: this.iteration,
        dispatches: this.tracker.count,
        outcome,
      },
    };
  }

  // records a system-failure notice and ends the turn "failed" so the loop stops trying
  async fail(reason: string): Promise<RoundOutcome> {
    const failureNotice: ChatMessage = {
      role: "assistant",
      content: `SYSTEM-FAILURE: failed to complete request — ${reason}`,
    };
    this.conversation.append(failureNotice);
    this.ctx.events.publish(OrchestratorEventTypes.SYSTEM_FAILURE, { reason });
    await this.flush();
    return {
      kind: "done",
      result: {
        finalMessage: failureNotice,
        iterations: this.iteration,
        dispatches: this.tracker.count,
        outcome: "failed",
      },
    };
  }

  // ends a dispatched turn on the agent's report_result: the final conversation line IS the verdict envelope
  // (single JSON line) so the record is self-describing, and outcome mirrors status so the step gate
  // fails closed on a "fail" verdict without parsing prose
  async finalizeReported(reported: ReportedTurnResult): Promise<RoundOutcome> {
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
      kind: "done",
      result: {
        finalMessage,
        iterations: this.iteration,
        dispatches: this.tracker.count,
        outcome: reported.status === "success" ? "satisfied" : "failed",
        reported,
      },
    };
  }
}
