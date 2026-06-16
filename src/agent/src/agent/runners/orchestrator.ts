import type { Conversation } from "../conversation/conversation.js";
import type { ToolDescriptor, ToolExecutionResult } from "@agent-local/mcp";
import { ScopedToolClient } from "../scoped-tool-client.js";
import type {
  ChatMessage,
  ChatResponse,
  LLMProvider,
  ToolCall,
} from "../providers/provider.js";
import {
  buildPromptedToolInstructions,
  extractPromptedToolCalls,
} from "../tool-adapter.js";
import { Summarizer, buildSummaryMessage } from "./summarizer.js";
import { Evaluator, type EvaluationVerdict } from "./evaluator.js";
import { foldCounters, foldDelegatedUsage } from "../session/session.js";
import { DispatchTracker } from "../synthetic-mcp/dispatch-tracker.js";
import type { ToolContext, TurnBindable } from "../synthetic-mcp/types.js";
import { createSubsessionsLocalMcp } from "../synthetic-mcp/subsessions-server.js";
import type { AgentRuntimeQueryable } from "../runtime/types.js";
import type { McpClientRegistry } from "../registries/mcp-registry.js";
import type { RunnerContext } from "./middleware/runner-middleware.js";
import { OrchestratorEventTypes } from "./runner-events.js";
import { Eventing } from "@agent-local/common/eventing";
import { ContextSnapshot } from "../context/context-loader.js";

// re-export for backwards compatibility
export type { OrchestratorEvent, OrchestratorListener } from "./runner-events.js";

export interface RunResult {
  finalMessage: ChatMessage;
  iterations: number;
  dispatches: number;
  // "satisfied" accepted, "capped" hit the iteration bound, "failed" judged unrecoverable; drives the headless exit code
  outcome: "satisfied" | "capped" | "failed";
}

// narrow contract satisfied structurally by Orchestrator, so the manager stays decoupled and construction acyclic
export interface SessionRunner {
  run(ctx: RunnerContext): Promise<RunResult>;
}

// drives the agentic loop for any role; the role selects model, visible tools, prompt, and iteration cap
// STATELESS: holds only its role; per-turn state and the runtime DI handle arrive via run()'s RunnerContext
// orchestrator role gates on the evaluator; executor role ends on the first tool-free response
export class Orchestrator {
  constructor(private readonly role: string) {}

  // runs one user turn end-to-end, appending to the runtime's Conversation; flushes per round
  // so a crash loses at most the round in flight, with finalize() backstopping the tail
  public async run(ctx: RunnerContext): Promise<RunResult> {
    // the turn bus is minted+chained by AgentRuntime.beginTurn; the runner only publishes onto it
    const turnEvents = ctx.events;
    const logger = ctx.logger;
    const session = ctx.session;
    const workspace = ctx.runtime.getWorkspace();
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

    // rebind the subsessions server to this turn's live coordinator so tool calls hit the right instance
    const coordinator = ctx.coordinator;
    if (coordinator) {
      const subsessionToolCtx: ToolContext = {
        session,
        workspace,
        sandboxRoot: mcpRegistry.sandboxRoot,
        coordinator,
        signal: ctx.signal,
      };
      mcpRegistry.registerClient(createSubsessionsLocalMcp(subsessionToolCtx));
    }

    // built after the subsessions rebind so the scoped client sees the live mounts
    const scopedClients = ScopedToolClient.forRole(mcpRegistry, modelsRegistry, this.role);
    const visibleTools = scopedClients.listTools();

    const maxDispatches = config.orchestration.maxExecutorDispatchesPerTurn!;
    const checkInterval = config.orchestration.validatorCheckIntervalDispatches ?? 0;
    const tracker = new DispatchTracker(maxDispatches, checkInterval);

    // skip binding for the executor role: its sub-run doesn't dispatch, so binding would clobber the parent's in-flight tracker
    if (this.role !== "executor") {
      const executorMcp = mcpRegistry.getClient("executor");
      if (executorMcp && typeof (executorMcp as unknown as TurnBindable).bindTurn === "function") {
        // chained under the turn so what the executor publishes bubbles up
        const mcpClientEvents = new Eventing();
        turnEvents.add(mcpClientEvents);
        (executorMcp as unknown as TurnBindable).bindTurn(ctx.signal, tracker, mcpClientEvents);
      }
    }

    turnEvents.publish(OrchestratorEventTypes.START, {
      orchestratorModel: provider.modelId,
      orchestratorTools: visibleTools,
      readToolCount: visibleTools.length,
    });

    const systemMessages = this.buildSystemMessages(provider, visibleTools, context);
    const workingMessages: ChatMessage[] = [...systemMessages, ...conversation.getMessages()];

    // capture where the first drained message lands so the evaluator sees the request onward
    const turnStartIndex = workingMessages.length;

    // the evaluator's anchor is the FIRST drained batch, set on the opening iteration and held for the turn
    let turnRequest: string | null = null;

    // recall runs once per turn, keyed on the first real request; guards against re-recalling each iteration
    let recalled = false;

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
    const temperature = this.role === "executor" ? executorTemperature! : orchestratorTemperature!;

    for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
      if (ctx.signal.aborted) {
        throw new Error("turn aborted: user requested stop");
      }

      // inbox is the sole source of user input; the first non-empty drain is this turn's request
      const injectedPrompts = ctx.pullInjectedPrompts?.() ?? [];
      for (const text of injectedPrompts) {
        const injected: ChatMessage = { role: "user", content: text };
        conversation.append(injected);
        workingMessages.push(injected);
        turnEvents.publish(OrchestratorEventTypes.INJECTED_INPUT, { iteration, content: text });
      }
      if (turnRequest === null && injectedPrompts.length > 0) {
        turnRequest = injectedPrompts.join("\n");
      }

      logger.debug("turn input drained", { iteration, drained: injectedPrompts.length, hasRequest: turnRequest !== null });

      // a wake with nothing queued has no request, so settle without calling the model
      if (turnRequest === null) {
        logger.debug("empty turn — no queued input, settling without model call", { sessionId: session.sessionId });
        return {
          finalMessage: { role: "assistant", content: "" },
          iterations: 0,
          dispatches: tracker.count,
          outcome: "satisfied",
        };
      }

      // recall on the first real request: the turn's query is now known, and an empty wake already settled above
      if (!recalled) {
        recalled = true;
        await this.maybeRecallMemory(mcpRegistry, turnRequest, workingMessages, turnEvents, ctx.signal);
      }

      turnEvents.publish(OrchestratorEventTypes.ITERATION, { iteration, max: maxIterations });

      // transient last message every call so the model stays anchored as the transcript grows
      const requestAnchor: ChatMessage = {
        role: "system",
        content: modelsRegistry.getAnchorText(turnRequest),
      };

      logger.debug("model call", { iteration, provider: provider.providerName, model: provider.modelId });
      let response: ChatResponse;
      try {
        response = await provider.chat([...workingMessages, requestAnchor], {
          tools: provider.supportsNativeTools ? visibleTools : [],
          temperature,
          signal: ctx.signal,
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Orchestrator (${provider.providerName}:${provider.modelId}) failed at iteration ${iteration}: ${errorMsg}`
        );
      }

      foldCounters(session.counters, response.usage);

      const { assistantMessage, toolCalls } = this.normaliseAssistantTurn(provider, response, turnEvents);

      // Content length + tool count distinguish a real answer from an empty reply.
      logger.debug("model response", { iteration, contentLength: assistantMessage.content.length, toolCalls: toolCalls.length });

      turnEvents.publish(OrchestratorEventTypes.MESSAGE, {
        iteration,
        content: assistantMessage.content,
        toolCallCount: toolCalls.length,
        usage: response.usage,
      });

      conversation.append(assistantMessage);
      workingMessages.push(assistantMessage);

      if (toolCalls.length === 0) {
        // Executor: first tool-free response is the RESULT — no evaluator gate.
        if (this.role === "executor") {
          return {
            finalMessage: assistantMessage,
            iterations: iteration,
            dispatches: tracker.count,
            outcome: "satisfied",
          };
        }

        // Orchestrator: gate through the evaluator.
        const verdict = await this.evaluateCompletion(
          ctx.runtime,
          turnRequest,
          assistantMessage.content,
          workingMessages.slice(turnStartIndex),
          turnEvents,
          ctx.signal
        );

        if (verdict.state === "satisfied" || verdict.state === "awaiting-input") {
          return {
            finalMessage: assistantMessage,
            iterations: iteration,
            dispatches: tracker.count,
            outcome: "satisfied",
          };
        }

        // terminal: stop trying rather than nudge-and-loop until the cap
        if (verdict.state === "failed") {
          return this.failTurn(verdict.reason, iteration, tracker.count, conversation, turnEvents);
        }

        // Nudges quote the request verbatim to prevent goal drift.
        const nudge: ChatMessage = {
          role: "user",
          content:
            verdict.state === "continue"
              ? `EVALUATOR: on track — ${verdict.reason}\n` +
                `The request for THIS turn is exactly: «${turnRequest}»\n` +
                "Keep going: take the next concrete action toward fulfilling it. " +
                "Do not stop until it is complete."
              : `EVALUATOR: off track — ${verdict.reason}\n` +
                `The request for THIS turn is exactly: «${turnRequest}»\n` +
                "Stop repeating what isn't working and change your approach. Re-check this " +
                "request and the current workspace state, then take a different next action.",
        };
        conversation.append(nudge);
        workingMessages.push(nudge);
        await conversation.flush();
        continue;
      }

      const toolMessages: ChatMessage[] = [];

      for (const call of toolCalls) {
        if (ctx.signal?.aborted) {
          throw new Error("turn aborted: user requested stop");
        }

        logger.debug("tool call start", { name: call.name });
        const execution: ToolExecutionResult = await scopedClients.callTool(
          call.name,
          call.arguments,
          turnEvents,
          ctx.signal
        );
        logger.debug("tool call end", { name: call.name, isError: execution.isError });
        // delegated cost lands in the tallied counters so own spend and dependency spend stay separately readable
        foldDelegatedUsage(session.counters, execution.usage);
        toolMessages.push(
          wrapToolResult(call, execution.isError ? `[tool-error] ${execution.content}` : execution.content)
        );
      }

      conversation.append(...toolMessages);
      workingMessages.push(...toolMessages);

      // mid-flight progress gate (orchestrator only) to catch no-progress loops before they hit the cap
      if (this.role !== "executor" && tracker.dueForPeriodicCheck()) {
        const verdict = await this.evaluateCompletion(
          ctx.runtime,
          turnRequest,
          "(in-progress checkpoint — no final answer yet)",
          workingMessages.slice(turnStartIndex),
          turnEvents,
          ctx.signal
        );
        if (verdict.state === "failed") {
          return this.failTurn(verdict.reason, iteration, tracker.count, conversation, turnEvents);
        }
        if (verdict.state === "unsatisfied") {
          const nudge: ChatMessage = {
            role: "user",
            content:
              `EVALUATOR: off track — ${verdict.reason}\n` +
              `The request for THIS turn is exactly: «${turnRequest}»\n` +
              "Stop repeating what isn't working and change your approach. Re-check this " +
              "request and the current workspace state, then take a different next action.",
          };
          conversation.append(nudge);
          workingMessages.push(nudge);
        }
      }

      // persist this round so a crash mid-turn loses at most the round in flight
      await conversation.flush();
    }

    const truncationNotice: ChatMessage = {
      role: "assistant",
      content:
        `ORCHESTRATOR: hit iteration cap of ${maxIterations} without a final answer. ` +
        "Try a narrower request or raise maxOrchestratorIterations in models.json.",
    };
    conversation.append(truncationNotice);
    turnEvents.publish(OrchestratorEventTypes.WARNING, {
      message: `${this.role} hit iteration cap`,
      iterations: maxIterations,
    });
    return {
      finalMessage: truncationNotice,
      iterations: maxIterations,
      dispatches: tracker.count,
      outcome: "capped",
    };
  }

  // --------------------------------------------------------------------------

  // records a system-failure notice and returns outcome "failed" so the caller stops trying
  private async failTurn(
    reason: string,
    iterations: number,
    dispatches: number,
    conversation: Conversation,
    events: Eventing
  ): Promise<RunResult> {
    const failureNotice: ChatMessage = {
      role: "assistant",
      content: `SYSTEM-FAILURE: failed to complete request — ${reason}`,
    };
    conversation.append(failureNotice);
    events.publish(OrchestratorEventTypes.SYSTEM_FAILURE, { reason });
    await conversation.flush();
    return { finalMessage: failureNotice, iterations, dispatches, outcome: "failed" };
  }

  // turn-start memory recall: fetches this session's relevant memories and injects them as context.
  // memomcp lives in the registry but in no role whitelist, so it is reachable here yet never a callable tool.
  // no-ops when unmounted (executor role, or no collection) and fails open so recall never blocks a turn.
  private async maybeRecallMemory(
    mcpRegistry: McpClientRegistry,
    query: string,
    workingMessages: ChatMessage[],
    events: Eventing,
    signal: AbortSignal
  ): Promise<void> {
    const memory = mcpRegistry.getClient("memomcp");
    if (!memory) return;

    events.publish(OrchestratorEventTypes.RECALL_START, {});

    let result: ToolExecutionResult;
    try {
      result = await memory.callTool("recall", { query }, signal);
    } catch (err) {
      events.publish(OrchestratorEventTypes.WARNING, {
        message: `memory recall failed: ${(err as Error).message}`,
      });
      return;
    }

    if (result.isError || result.content.trim().length === 0) return;

    // transient: pushed into the turn's working set only, never the persisted transcript — recall reruns
    // each turn (like the request anchor), so persisting would bloat the conversation and the summary
    workingMessages.push({
      role: "system",
      content: `Relevant memories recalled for this request (use if helpful):\n\n${result.content}`,
    });

    events.publish(OrchestratorEventTypes.RECALL_FINALIZE, { chars: result.content.length });
  }

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

  private async evaluateCompletion(
    runtime: AgentRuntimeQueryable,
    question: string,
    proposedAnswer: string,
    transcript: ChatMessage[],
    events: Eventing,
    signal?: AbortSignal
  ): Promise<EvaluationVerdict> {
    events.publish(OrchestratorEventTypes.EVALUATION_START, {});

    try {
      const config = await runtime.getConfigurationRegistry().getModelsConfiguration();

      const evaluator = new Evaluator(runtime);
      const verdict = await evaluator.evaluate(
        { question, proposedAnswer, transcript },
        { signal, temperature: config.orchestration.evaluatorTemperature }
      );
      if (verdict?.reason)
      {
        events.publish(OrchestratorEventTypes.EVALUATION_VERDICT, {
          state: verdict.state,
          reason: verdict.reason,
        });
      }
      return verdict;
    } catch (err) {
      // fail open: never trap the user because the judge errored
      events.publish(OrchestratorEventTypes.WARNING, {
        message: `evaluation failed, treating as satisfied: ${(err as Error).message}`,
      });
      return { state: "satisfied", reason: "evaluator error; defaulting to satisfied" };
    }
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

  private normaliseAssistantTurn(
    provider: LLMProvider,
    response: ChatResponse,
    events: Eventing
  ): { assistantMessage: ChatMessage; toolCalls: ToolCall[] } {
    if (provider.supportsNativeTools) {
      const nativeCalls = response.message.toolCalls ?? [];
      if (nativeCalls.length > 0) {
        return { assistantMessage: response.message, toolCalls: nativeCalls };
      }

      const { toolCalls: recoveredCalls, cleanedContent } = extractPromptedToolCalls(response.message);
      if (recoveredCalls.length > 0) {
        events.publish(OrchestratorEventTypes.WARNING, {
          message:
            "Native-tool model emitted tool call as JSON in prose; recovered via prompted-JSON fallback.",
          model: provider.modelId,
          recoveredCount: recoveredCalls.length,
        });
        return {
          assistantMessage: {
            role: "assistant",
            content: cleanedContent,
            toolCalls: recoveredCalls,
          },
          toolCalls: recoveredCalls,
        };
      }
      return { assistantMessage: response.message, toolCalls: nativeCalls };
    }

    const { toolCalls, cleanedContent } = extractPromptedToolCalls(response.message);
    return {
      assistantMessage: {
        role: "assistant",
        content: cleanedContent,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      },
      toolCalls,
    };
  }
}

function wrapToolResult(call: ToolCall, content: string): ChatMessage {
  return {
    role: "tool",
    content,
    toolCallId: call.id,
    toolName: call.name,
  };
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
