import type { Conversation } from "../conversation/conversation.js";
import type { ToolExecutionResult } from "../mcp/mcp-client.js";
import type {
  ChatMessage,
  ChatResponse,
  LLMProvider,
  ToolCall,
  ToolDescriptor,
} from "../providers/provider.js";
import {
  buildPromptedToolInstructions,
  extractPromptedToolCalls,
} from "../tool-adapter.js";
import { Summarizer, buildSummaryMessage } from "./summarizer.js";
import { Evaluator, type EvaluationVerdict } from "./evaluator.js";
import { ScopedToolClient } from "../scoped-tool-client.js";
import { foldCounters, foldDelegatedUsage } from "../session/session.js";
import type { SubSessionCoordinator } from "./subsession.js";
import { DispatchTracker } from "../synthetic-mcp/dispatch-tracker.js";
import type { ToolContext, TurnBindable } from "../synthetic-mcp/types.js";
import { createSubsessionsLocalMcp } from "../synthetic-mcp/subsessions-server.js";
import type { AgentRuntimeQueryable } from "../runtime/types.js";
import { OrchestratorEventTypes } from "./runner-events.js";
import type { OrchestratorListener, RunnerListener } from "./runner-events.js";
import { ContextSnapshot } from "../context/context-loader.js";

// Re-export for backwards compatibility
export type { OrchestratorEvent, OrchestratorListener } from "./runner-events.js";

/**
 * Orchestrator.
 *
 * Runs the agentic loop for any role (orchestrator or executor). The role
 * determines which model is used, which tools are visible, which system
 * prompt is applied, and the iteration cap.
 *
 * For the "orchestrator" role the loop coordinates via read-only tools plus
 * `executor__dispatch`; for the "executor" role it runs the write tools and
 * terminates on the first tool-free response (no evaluator gate).
 *
 * The Orchestrator is STATELESS. It holds only app-level dependencies
 * (the model registry and tool client); every piece of per-turn state —
 * the transcript and the project context — arrives as arguments to `run`
 * via the `Session` and `Workspace` it is handed. The Initializer owns
 * those objects, their lifecycle, and their persistence.
 */

export interface RunOptions {
  signal?: AbortSignal;
  onEvent?: RunnerListener;
  /**
   * Coordinator that lets this run spawn and manage sub-sessions. When present,
   * the orchestrator exposes the synthetic create/status/finalize sub-session
   * tools and intercepts them. Detached sub-session runs are launched WITHOUT a
   * coordinator, so sub-sessions are one level deep.
   */
  coordinator?: SubSessionCoordinator;
  /**
   * Pull seam for externally-injected prompts. Called at the top of each loop
   * iteration; any returned strings are appended to the conversation as user
   * turns before the model is asked. This is how an outside producer (a REPL
   * command, a future API call) steers a live run without racing the loop.
   */
  pullInjectedPrompts?: () => string[];
}

export interface RunResult {
  finalMessage: ChatMessage;
  iterations: number;
  dispatches: number;
  /**
   * How the run ended. "satisfied" — the evaluator accepted the final answer;
   * "capped" — the loop hit the orchestrator iteration cap without a satisfied
   * verdict (the natural "tried too many times / all fails" bound). Lets a
   * caller distinguish a real completion from a give-up without inspecting the
   * transcript, and drives the headless exit code.
   */
  outcome: "satisfied" | "capped";
}

/**
 * The capability the SessionManager needs to drive a sub-session: run a session
 * to completion. Declared here and satisfied structurally by `Orchestrator`, so
 * the manager depends on this narrow contract rather than the concrete class —
 * keeping the orchestrator ⇄ manager construction acyclic.
 */
export interface SessionRunner {
  run(options?: RunOptions): Promise<RunResult>;
}

export class Orchestrator {
  private runtime!: AgentRuntimeQueryable;

  constructor(private readonly role: string, runtime?: AgentRuntimeQueryable) {
    if (runtime) {
      this.runtime = runtime;
    }
  }

  /** Set the runtime after construction (used by AgentRuntime.build). */
  setRuntime(runtime: AgentRuntimeQueryable): void {
    this.runtime = runtime;
  }

  /**
   * Run one user turn end-to-end for the session in the runtime.
   * Appends to the runtime's Conversation (the turn's work product); holds
   * no reference to it afterward. The transcript is flushed to its rolling
   * file at the end of every round; the runtime's finalize() backstops the
   * tail on every exit path.
   */
  public async run(options: RunOptions = {}): Promise<RunResult> {
    const emit = options.onEvent ?? (() => {});
    const session = this.runtime.getSession();
    const workspace = this.runtime.getWorkspace();
    const modelsRegistry = this.runtime.getModelsRegistry();
    const mcpRegistry = this.runtime.getMcpClientRegistry();
    const providersRegistry = this.runtime.getProvidersRegistry();
    const conversation = this.runtime.getConversation();

    // Resolve a role's tool servers (role → model → models.json `mcp` list),
    // skipping any that are declared but not mounted (e.g. stdio servers from
    // mcp.json until spawning lands), so a single scoped client fronts the whole set.
    const clientsFor = (role: string) =>
      modelsRegistry.getValidMcpForModel(role).flatMap((serverName) => {
        const client = mcpRegistry.getClient(serverName);
        return client ? [client] : [];
      });

    const config = await this.runtime.getConfigurationRegistry().getModelsConfiguration()!;
    const contextLoader = this.runtime.getContextLoader();
    // The snapshot stamped by ContextMiddleware is the ONLY source of the
    // system prompt and project direction — the runner never assembles
    // context itself, so what ran is always exactly what the hash records.
    const contextHash = session.contextHashes ? session.contextHashes[this.role] : null;
    const context = contextHash ? await contextLoader.getContextSnapshot(contextHash) : null;
    if (!context) {
      throw new Error(
        `Orchestrator: no context snapshot for role "${this.role}" ` +
          `(hash: ${contextHash ?? "unstamped"}). ContextMiddleware must run before any turn.`
      );
    }

    await this.maybeSummarize(conversation, emit, options.signal);
    // No opening append: every user message for this turn — including the first —
    // arrives through the inbox drain inside the loop (the single injection path).

    const provider = providersRegistry.getProvider(modelsRegistry.getProviderForRole(this.role));

    // Re-bind the subsessions server to this turn's live coordinator so tool
    // calls land on the right instance. registerClient is keyed by server name,
    // so this replaces the placeholder in the registry.
    const coordinator = options.coordinator;
    if (coordinator) {
      const subsessionToolCtx: ToolContext = {
        session,
        workspace,
        sandboxRoot: mcpRegistry.sandboxRoot,
        coordinator,
        signal: options.signal,
      };
      mcpRegistry.registerClient(createSubsessionsLocalMcp(subsessionToolCtx));
    }

    const scopedClient = new ScopedToolClient(clientsFor(this.role), emit);
    const visibleTools = scopedClient.listTools();

    const maxDispatches = config.orchestration.maxExecutorDispatchesPerTurn!;
    const checkInterval = config.orchestration.validatorCheckIntervalDispatches ?? 0;
    const tracker = new DispatchTracker(maxDispatches, checkInterval);

    // Bind per-turn context on the executor LocalMcp only for roles that
    // actually dispatch to it (orchestrator-family). The executor sub-run
    // itself does not dispatch further, so we skip binding there to avoid
    // overwriting the parent turn's tracker while a dispatch is in-flight.
    if (this.role !== "executor") {
      const executorMcp = mcpRegistry.getClient("executor");
      if (executorMcp && typeof (executorMcp as unknown as TurnBindable).bindTurn === "function") {
        (executorMcp as unknown as TurnBindable).bindTurn(
          options.signal,
          emit as OrchestratorListener,
          tracker
        );
      }
    }

    emit({
      type: OrchestratorEventTypes.START,
      data: {
        orchestratorModel: provider.modelId,
        orchestratorTools: visibleTools,
        readToolCount: visibleTools.length,
      },
    });

    const systemMessages = this.buildSystemMessages(provider, visibleTools, context);
    const workingMessages: ChatMessage[] = [...systemMessages, ...conversation.getMessages()];

    // The turn's user input arrives via the inbox drain below; capture where its
    // first message will land so the evaluator sees the request onward.
    const turnStartIndex = workingMessages.length;

    // The request that anchors the evaluator is the FIRST drained batch — set on
    // the opening iteration, then held for the rest of the turn.
    let turnRequest: string | null = null;

    const maxIterations =
      this.role === "executor"
        ? (config.orchestration.maxExecutorIterationsPerAsk ?? 6)
        : (config.orchestration.maxOrchestratorIterations ?? 16);

    const orchestratorTemperature = config.orchestration.orchestratorTemperature;
    const executorTemperature = config.orchestration.executorTemperature;
    const temperature = this.role === "executor" ? executorTemperature! : orchestratorTemperature!;

    for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
      if (options.signal?.aborted) {
        throw new Error("turn aborted: user requested stop");
      }

      // The inbox is the sole source of user input — drain it before asking the
      // model. The first non-empty drain is THIS turn's request (the anchor).
      const injectedPrompts = options.pullInjectedPrompts?.() ?? [];
      for (const text of injectedPrompts) {
        const injected: ChatMessage = { role: "user", content: text };
        conversation.append(injected);
        workingMessages.push(injected);
        emit({ type: OrchestratorEventTypes.INJECTED_INPUT, data: { iteration, content: text } });
      }
      if (turnRequest === null && injectedPrompts.length > 0) {
        turnRequest = injectedPrompts.join("\n");
      }

      // A wake with nothing queued (the scheduling turn already drained it):
      // no request to act on, so settle cleanly without calling the model.
      if (turnRequest === null) {
        return {
          finalMessage: { role: "assistant", content: "" },
          iterations: 0,
          dispatches: tracker.count,
          outcome: "satisfied",
        };
      }

      emit({ type: OrchestratorEventTypes.ITERATION, data: { iteration, max: maxIterations } });

      // Re-assert the request as the LAST message of every chat call (transient,
      // never pushed) so the model stays anchored as the transcript grows — the
      // same verbatim re-grounding the evaluator gets.
      const requestAnchor: ChatMessage = {
        role: "system",
        content: modelsRegistry.getAnchorText(turnRequest),
      };

      let response: ChatResponse;
      try {
        response = await provider.chat([...workingMessages, requestAnchor], {
          tools: provider.supportsNativeTools ? visibleTools : [],
          temperature,
          signal: options.signal,
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Orchestrator (${provider.providerName}:${provider.modelId}) failed at iteration ${iteration}: ${errorMsg}`
        );
      }

      foldCounters(session.counters, response.usage);

      const { assistantMessage, toolCalls } = this.normaliseAssistantTurn(provider, response, emit);

      emit({
        type: OrchestratorEventTypes.MESSAGE,
        data: {
          iteration,
          content: assistantMessage.content,
          toolCallCount: toolCalls.length,
          usage: response.usage,
        },
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
          turnRequest,
          assistantMessage.content,
          workingMessages.slice(turnStartIndex),
          emit,
          options.signal
        );

        if (verdict.state === "satisfied" || verdict.state === "awaiting-input") {
          return {
            finalMessage: assistantMessage,
            iterations: iteration,
            dispatches: tracker.count,
            outcome: "satisfied",
          };
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
        if (options.signal?.aborted) {
          throw new Error("turn aborted: user requested stop");
        }

        const execution: ToolExecutionResult = await scopedClient.callTool(call.name, call.arguments);
        // Tools that ran a model of their own (executor dispatch) report the
        // delegated cost on the result; it lands in the *Tallied counters so
        // own chat spend and dependency spend stay separately readable.
        foldDelegatedUsage(session.counters, execution.usage);
        toolMessages.push(
          wrapToolResult(call, execution.isError ? `[tool-error] ${execution.content}` : execution.content)
        );
      }

      conversation.append(...toolMessages);
      workingMessages.push(...toolMessages);

      // Periodic progress gate (orchestrator only). Every N successful dispatches,
      // run the validator mid-flight to catch no-progress loops before they cap.
      if (this.role !== "executor" && tracker.dueForPeriodicCheck()) {
        const verdict = await this.evaluateCompletion(
          turnRequest,
          "(in-progress checkpoint — no final answer yet)",
          workingMessages.slice(turnStartIndex),
          emit,
          options.signal
        );
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

      // End of round: persist this iteration's appends to the rolling file so
      // a crash mid-turn loses at most the round in flight.
      await conversation.flush();
    }

    const truncationNotice: ChatMessage = {
      role: "assistant",
      content:
        `ORCHESTRATOR: hit iteration cap of ${maxIterations} without a final answer. ` +
        "Try a narrower request or raise maxOrchestratorIterations in models.json.",
    };
    conversation.append(truncationNotice);
    emit({
      type: OrchestratorEventTypes.WARNING,
      data: { message: `${this.role} hit iteration cap`, iterations: maxIterations },
    });
    return {
      finalMessage: truncationNotice,
      iterations: maxIterations,
      dispatches: tracker.count,
      outcome: "capped",
    };
  }

  // --------------------------------------------------------------------------

  private async maybeSummarize(
    conversation: Conversation,
    emit: RunnerListener,
    signal?: AbortSignal
  ): Promise<void> {
    const config = await this.runtime.getConfigurationRegistry().getModelsConfiguration();
    const threshold = config.orchestration.summarizeAtMessages!;
    const messages = conversation.getMessages();
    if (messages.length <= threshold) return;

    const desiredKeep = config.orchestration.summarizerKeepLastN!;
    const tailStart = findCleanTailStart(messages, desiredKeep);
    if (tailStart === 0) return;

    const prefix = messages.slice(0, tailStart);
    const tail = messages.slice(tailStart);

    emit({
      type: OrchestratorEventTypes.SUMMARIZATION_START,
      data: { messageCount: prefix.length },
    });

    let summaryText: string;
    try {
      const summarizer = new Summarizer(this.runtime);
      summaryText = await summarizer.summarize(prefix, { signal });
    } catch (err) {
      emit({
        type: OrchestratorEventTypes.WARNING,
        data: { message: `summarization failed: ${(err as Error).message}` },
      });
      return;
    }

    const summaryMessage = buildSummaryMessage(summaryText, prefix.length);

    await conversation.replaceAll([summaryMessage, ...tail]);

    emit({
      type: OrchestratorEventTypes.SUMMARIZATION,
      data: {
        summarizedCount: prefix.length,
        keptCount: tail.length,
        summaryChars: summaryText.length,
      },
    });
  }

  private async evaluateCompletion(
    question: string,
    proposedAnswer: string,
    transcript: ChatMessage[],
    emit: OrchestratorListener,
    signal?: AbortSignal
  ): Promise<EvaluationVerdict> {
    emit({ type: OrchestratorEventTypes.EVALUATION_START, data: {} });

    try {
      const config = await this.runtime.getConfigurationRegistry().getModelsConfiguration();
      const evaluator = new Evaluator(this.runtime);
      const verdict = await evaluator.evaluate(
        { question, proposedAnswer, transcript },
        { signal, temperature: config.orchestration.evaluatorTemperature }
      );
      emit({
        type: OrchestratorEventTypes.EVALUATION_VERDICT,
        data: { state: verdict.state, reason: verdict.reason },
      });
      return verdict;
    } catch (err) {
      // Fail open — never trap the user because the judge errored.
      emit({
        type: OrchestratorEventTypes.WARNING,
        data: { message: `evaluation failed, treating as satisfied: ${(err as Error).message}` },
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

    // Prompted-JSON instructions stay per-turn: the live tool set can differ
    // from the snapshot's (the subsessions server is rebound each turn).
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
    emit: OrchestratorListener
  ): { assistantMessage: ChatMessage; toolCalls: ToolCall[] } {
    if (provider.supportsNativeTools) {
      const nativeCalls = response.message.toolCalls ?? [];
      if (nativeCalls.length > 0) {
        return { assistantMessage: response.message, toolCalls: nativeCalls };
      }

      const { toolCalls: recoveredCalls, cleanedContent } = extractPromptedToolCalls(response.message);
      if (recoveredCalls.length > 0) {
        emit({
          type: OrchestratorEventTypes.WARNING,
          data: {
            message:
              "Native-tool model emitted tool call as JSON in prose; recovered via prompted-JSON fallback.",
            model: provider.modelId,
            recoveredCount: recoveredCalls.length,
          },
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

// ---------------------------------------------------------------------------
// Wrap a tool result into a role:"tool" message.
// ---------------------------------------------------------------------------

function wrapToolResult(call: ToolCall, content: string): ChatMessage {
  return {
    role: "tool",
    content,
    toolCallId: call.id,
    toolName: call.name,
  };
}

/**
 * Find a tail-start index that begins on a turn which can legally HEAD a
 * provider contents array: a `user` turn, or an `assistant` turn that is NOT
 * itself a tool-call. Two kinds of head are orphans and must be skipped:
 *
 *   - a `role:"tool"` message — it must follow the assistant turn that called
 *     it; kept alone it breaks providers that validate tool_call_id pairing.
 *   - an `assistant` turn carrying `toolCalls` — it becomes a model
 *     functionCall turn, which Gemini rejects unless it immediately follows a
 *     user turn or a functionResponse.
 */
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
