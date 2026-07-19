import type { Conversation } from "../conversation/conversation.js";
import type { ToolDescriptor } from "@agent-local/mcp";
import { ScopedToolClient } from "../scoped-tool-client.js";
import type { ChatMessage, LLMProvider } from "../providers/provider.js";
import { buildPromptedToolInstructions } from "../tool-adapter.js";
import { Summarizer, buildSummaryMessage } from "./summarizer.js";
import { DispatchTracker } from "../synthetic-mcp/dispatch-tracker.js";
import type { TurnBindable, TurnBinding } from "../synthetic-mcp/types.js";
import { TURN_RESULT_SERVER_NAME } from "../synthetic-mcp/turn-result-server.js";
import { TurnResultCapture } from "../synthetic-mcp/turn-result-tools.js";
import type { ReportedTurnResult } from "../synthetic-mcp/types.js";
import type { AgentRuntimeQueryable } from "../runtime/types.js";
import type { RunnerContext } from "./middleware/runner-middleware.js";
import { OrchestratorEventTypes } from "./runner-events.js";
import { Eventing } from "@agent-local/common/eventing";
import { ContextSnapshot } from "../context/context-loader.js";
import { Turn } from "./middleware/turn.js";
import { PromptRound } from "./middleware/promptround.js";
import { MemoryRound } from "./middleware/memoryround.js";
import { ModelRound } from "./middleware/modelround.js";
import { ResponseRound } from "./middleware/responseround.js";
import { ToolRound } from "./middleware/toolround.js";

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

// drives the agentic loop for any role; the role selects model, visible tools, prompt, and iteration cap
// STATELESS: holds only its role; per-turn state lives in the TurnState the rounds share (see middleware/)
// orchestrator role gates on the evaluator; executor role ends on the first tool-free response
export class Orchestrator {
  constructor(private readonly role: string) {}

  // runs one user turn end-to-end: builds the TurnState, then drives the round list per iteration;
  // rounds flush per round so a crash loses at most the round in flight, with finalize() backstopping the tail
  public async run(ctx: RunnerContext): Promise<RunResult> {
    // the turn bus is minted+chained by AgentRuntime.beginTurn; the runner only publishes onto it
    const turnEvents = ctx.events;
    const session = ctx.session;
    const modelsRegistry = ctx.runtime.getModelsRegistry();
    const mcpRegistry = ctx.runtime.getMcpClientRegistry();
    const providersRegistry = ctx.runtime.getProvidersRegistry();
    const conversation = ctx.runtime.getConversation();

    const config = await ctx.runtime.getConfigurationRegistry().getModelsConfiguration()!;
    const contextLoader = ctx.runtime.getContextLoader();
    // the ContextMiddleware snapshot is the ONLY source of prompt+direction, so what ran always matches the hash
    const contextHash = session.contextHashes ? session.contextHashes[this.role] : null;
    const context = contextHash ? await contextLoader.getContextSnapshot(contextHash) : null;
    if (!context) {
      throw new Error(
        `Orchestrator: no context snapshot for role "${this.role}" ` +
          `(hash: ${contextHash ?? "unstamped"}). ContextMiddleware must run before any turn.`
      );
    }

    await this.maybeSummarize(ctx.runtime, conversation, turnEvents, ctx.signal);
    // no opening append: every user message arrives through the inbox drain inside the loop

    const provider = providersRegistry.getProvider(modelsRegistry.getProviderForRole(this.role));

    // structured mode IS "is turnresult mounted" — driven solely by the role's whitelist (only workflow-orchestrator
    // lists it), like the executor/memomcp seams. the executor reports to its parent, not a workflow, so it's excluded.
    // the sink is minted regardless so the post-round check is uniform; the bind pass below wires it in.
    const structuredMode = !!mcpRegistry.getClient(TURN_RESULT_SERVER_NAME) && this.role !== "executor";
    const resultSink = new TurnResultCapture();

    const scopedClients = ScopedToolClient.forRole(mcpRegistry, modelsRegistry, this.role);
    const visibleTools = scopedClients.listTools();

    const maxDispatches = config.orchestration.maxExecutorDispatchesPerTurn!;
    const checkInterval = config.orchestration.validatorCheckIntervalDispatches ?? 0;
    const tracker = new DispatchTracker(maxDispatches, checkInterval);

    // ONE per-turn seam: servers register once at build; those holding turn state take it here via bindTurn.
    // skipped for the executor role: its sub-run doesn't dispatch or report, so nothing needs binding there.
    if (this.role !== "executor") {
      // chained under the turn so what bound servers publish bubbles up
      const mcpClientEvents = new Eventing();
      turnEvents.add(mcpClientEvents);
      const binding: TurnBinding = { signal: ctx.signal, tracker, events: mcpClientEvents, resultSink };
      for (const client of mcpRegistry.listClients()) {
        const bindable = client as unknown as Partial<TurnBindable>;
        if (typeof bindable.bindTurn === "function") bindable.bindTurn(binding);
      }
    }

    turnEvents.publish(OrchestratorEventTypes.START, {
      orchestratorModel: provider.modelId,
      orchestratorTools: visibleTools,
      readToolCount: visibleTools.length,
    });

    const systemMessages = this.buildSystemMessages(provider, visibleTools, context);
    const workingMessages: ChatMessage[] = [...systemMessages, ...conversation.getMessages()];

    // the model's own iterationCap wins; absent it, fall back to the role default
    const roleIterationDefault =
      this.role === "executor"
        ? (config.orchestration.maxExecutorIterationsPerAsk ?? 6)
        : (config.orchestration.maxOrchestratorIterations ?? 16);
    const modelName = modelsRegistry.getProviderForRole(this.role);
    const maxIterations =
      modelsRegistry.getIterationCapForModel(modelName) ?? roleIterationDefault;

    const orchestratorTemperature = config.orchestration.orchestratorTemperature;
    const executorTemperature = config.orchestration.executorTemperature;

    // the turn runs itself: the iteration body is its ordered round list, and a round
    // ends the turn, skips to the next iteration, or passes to the round below
    const turn = new Turn(ctx, {
      role: this.role,
      provider,
      scopedClients,
      visibleTools,
      tracker,
      resultSink,
      conversation,
      config,
      structuredMode,
      temperature: this.role === "executor" ? executorTemperature! : orchestratorTemperature!,
      streaming: ctx.runtime.isStreamOutputEnabled(),
      maxIterations,
      openingMessages: workingMessages,
      rounds: [
        new PromptRound(ctx),
        new MemoryRound(ctx),
        new ModelRound(ctx),
        new ResponseRound(ctx),
        new ToolRound(ctx),
      ],
    });
    return turn.runAsync();
  }

  // --------------------------------------------------------------------------

  private async maybeSummarize(
    runtime: AgentRuntimeQueryable,
    conversation: Conversation,
    events: Eventing,
    signal: AbortSignal
  ): Promise<void> {
    const config = await runtime.getConfigurationRegistry().getModelsConfiguration();
    const threshold = config.orchestration.summarizeAtMessages!;
    const messages = conversation.getMessages();
    if (messages.length <= threshold) return;

    const desiredKeep = config.orchestration.summarizerKeepLastN!;
    const tailStart = findCleanTailStart(messages, desiredKeep);
    if (tailStart === 0) return;

    const prefix = messages.slice(0, tailStart);
    const tail = messages.slice(tailStart);

    events.publish(OrchestratorEventTypes.SUMMARIZATION_START, { messageCount: prefix.length });

    let summaryText: string;
    try {
      const summarizer = new Summarizer(runtime);
      summaryText = await summarizer.summarize(prefix, { signal });
    } catch (err) {
      events.publish(OrchestratorEventTypes.WARNING, {
        message: `summarization failed: ${(err as Error).message}`,
      });
      return;
    }

    const summaryMessage = buildSummaryMessage(summaryText, prefix.length);

    await conversation.replaceAll([summaryMessage, ...tail]);

    events.publish(OrchestratorEventTypes.SUMMARIZATION, {
      summarizedCount: prefix.length,
      keptCount: tail.length,
      summaryChars: summaryText.length,
    });
  }

  private buildSystemMessages(
    provider: LLMProvider,
    visibleTools: ToolDescriptor[],
    context: ContextSnapshot
  ): ChatMessage[] {
    const messages: ChatMessage[] = [];

    if (context.projectContext) {
      messages.push({
        role: "system",
        content:
          `Treat this as standing direction from the user; follow it unless ` +
          `a specific request overrides it.\n\n` +
          context.projectContext,
      });
    }

    // built per-turn because the live tool set can differ from the snapshot's (subsessions rebound each turn)
    const promptedInstructions = provider.supportsNativeTools
      ? ""
      : buildPromptedToolInstructions(visibleTools);

    messages.push({
      role: "system",
      content: context.systemPrompt + promptedInstructions,
    });

    return messages;
  }
}

// finds a tail-start that can legally HEAD a provider contents array (a user turn, or a
// non-tool-call assistant turn), skipping orphan tool results and tool-call turns that providers reject
function findCleanTailStart(messages: readonly ChatMessage[], desiredTailLen: number): number {
  const initial = Math.max(0, messages.length - desiredTailLen);
  for (let i = initial; i < messages.length; i += 1) {
    const message = messages[i];
    if (message.role === "user") return i;
    if (message.role === "assistant" && !(message.toolCalls && message.toolCalls.length > 0)) {
      return i;
    }
  }
  return messages.length;
}
