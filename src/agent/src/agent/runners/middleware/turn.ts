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
import { guid, uuid } from "zod/v4";
import { randomUUID } from "node:crypto";

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
  streaming: boolean;
  rounds: readonly IRound[];
}

export type TurnOutcome =
  | { kind: "next-iteration" }
  | { kind: "done"; result: RunResult };


// one user turn as an object: owns the per-turn state, the transcript writes, the outcome
// envelopes, and the iteration loop that drives its rounds — the runner only constructs it
// transcript invariant: append() persists, injectTransient() does not; rounds never touch Conversation
export class Turn {
  readonly id: string;
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
  readonly workingMessages: ChatMessage[] = [];

  turnRequest: string | null = null;
  contextBuilt = false;
  recalled = false;
  summarized = false;
  toolCallsMade = 0;
  chatStarted = false;
  // per-iteration handoff: ModelRound writes, the rounds below it read
  assistantMessage: ChatMessage | null = null;
  toolCalls: ToolCall[] = [];

  private readonly ctx: RunnerContext;
  private readonly conversation: Conversation;
  // filled by SystemMessagesRound at turn start; empty until then, so seedOpeningSet stays valid
  private contextMessages: ChatMessage[] = [];
  private readonly rounds: readonly IRound[];
  // where the turn's first drained message lands, so the evaluator sees the request onward;
  // recomputed whenever SystemMessagesRound/SummarizeRound reseed the opening set
  private turnStartIndex = 0;

  constructor(ctx: RunnerContext, options: TurnOptions) {
    this.id = randomUUID().toString();
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
    this.streaming = options.streaming;
    this.rounds = options.rounds;
    this.seedOpeningSet();
    this.temperature = this.getTemperature();

  }

  // ---------------------------------------------------------------------------
  // Loop
  // ---------------------------------------------------------------------------

  // drives the round list per iteration and obeys each round's outcome; runs to the
  // cap only when no round ever ends the turn, which is itself a reportable outcome
  async runAsync(): Promise<TurnOutcome> {

    for (const round of this.rounds) {
      const outcome = await round.runAsync(this);
      if (outcome.kind === "done")
      {
        return {
          kind: "done",
          result: outcome.result
        }
      }
      if (outcome.kind === "next-iteration")
      {
        break;
      }
    }
    return {
      kind: "next-iteration"
    }
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
  // this turn appends its own work (SystemMessagesRound is the first round, ahead of the request drain)
  setContextMessages(messages: ChatMessage[]): void {
    this.contextMessages = messages;
    this.seedOpeningSet();
  }

  // the live persisted history the turn seeds from; SummarizeRound reads it to decide on compaction
  history(): readonly ChatMessage[] {
    return this.conversation.getMessages();
  }

  // summarization is the one conversation-level rewrite: swap the persisted history for the compacted
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

  private getTemperature(): number
  {
    const orchestratorTemperature = this.config.orchestration.orchestratorTemperature;
    const executorTemperature = this.config.orchestration.executorTemperature;
    const temperature = this.role === "executor" ?
      executorTemperature! : orchestratorTemperature!;
    return temperature;
  }

  // ---------------------------------------------------------------------------
  // Outcomes
  // ---------------------------------------------------------------------------

  settle(finalMessage: ChatMessage, outcome: "satisfied" | "awaiting-input"): RoundOutcome {
    return {
      kind: "done",
      result: {
        finalMessage,
        iterations: 0,
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
        iterations: 0,
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
      iteration: 0,
      content: finalMessage.content,
      toolCallCount: 0,
    });
    await this.flush();
    return {
      kind: "done",
      result: {
        finalMessage,
        iterations: 0,
        dispatches: this.tracker.count,
        outcome: reported.status === "success" ? "satisfied" : "failed",
        reported,
      },
    };
  }
}
