import type { ToolDescriptor } from "@agent-local/mcp";
import type { Conversation } from "../conversation/conversation.js";
import type { ChatMessage, LLMProvider } from "../providers/provider.js";
import type { ModelsFile } from "../registries/configuration-registry.js";
import type { ScopedToolClient } from "../scoped-tool-client.js";
import type { DispatchTracker } from "../synthetic-mcp/dispatch-tracker.js";
import type { ReportedTurnResult } from "../synthetic-mcp/types.js";
import type { TurnResultCapture } from "../synthetic-mcp/turn-result-tools.js";
import type { RunResult } from "./orchestrator.js";
import { OrchestratorEventTypes } from "./runner-events.js";
import type { RunnerContext } from "./middleware/runner-middleware.js";
import type { TurnProfile } from "./turn-profile.js";
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
  // Results
  // ---------------------------------------------------------------------------

  // a wake whose inbox was already drained: nothing ran, and headless accounting must see that
  idle(): RunResult {
    return {
      finalMessage: { role: "assistant", content: "" },
      iterations: 0,
      dispatches: this.tracker.count,
      outcome: "satisfied",
    };
  }

  settle(finalMessage: ChatMessage, outcome: "satisfied" | "awaiting-input"): RunResult {
    return {
      finalMessage,
      iterations: this.iteration,
      dispatches: this.tracker.count,
      outcome,
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
