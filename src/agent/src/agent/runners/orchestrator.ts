import { Executor } from "./executor.js";
import type { ToolExecutionResult } from "../mcp/mcp-client.js";
import type {
  ChatMessage,
  ChatResponse,
  LLMProvider,
  ToolCall,
  ToolDescriptor,
} from "../providers/provider.js";
import { ORCHESTRATOR_SYSTEM_PROMPT } from "../context/system-prompt.js";
import {
  buildPromptedToolInstructions,
  extractPromptedToolCalls,
} from "../tool-adapter.js";
import { Summarizer, buildSummaryMessage } from "./summarizer.js";
import { Evaluator, type EvaluationVerdict } from "./evaluator.js";
import { ScopedToolClient } from "../scoped-tool-client.js";
import type { SessionCounters } from "../session/session.js";
import type { SubSessionCoordinator } from "./subsession.js";
import {
  DispatchTracker,
  type SyntheticMcpContext,
  type ToolContext,
} from "../synthetic-mcp/index.js";
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
 * Coordinates execution; never executes. The orchestrator LLM is given
 * the read-only context tools (read_file, list_dir, glob, grep, codemcp.*)
 * plus a single synthetic tool — `dispatch_executor` — which is the only
 * way for it to cause a mutation.
 *
 * When the LLM calls `dispatch_executor`, the orchestrator catches the
 * call before it touches MCP, hands the ask to the Executor sub-agent,
 * and feeds the structured feedback (ACK + RESULT + deterministic
 * verdict) back to the LLM as a `role: "tool"` message. The LLM then
 * recalculates: next dispatch, or final answer.
 *
 * The orchestrator is STATELESS. It holds only app-level dependencies
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
  run(userInput: string, options?: RunOptions): Promise<RunResult>;
}

export class Orchestrator {
  private runtime!: AgentRuntimeQueryable;

  constructor(runtime?: AgentRuntimeQueryable) {
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
   * Mutates `session.conversation` in place (the turn's work product); holds
   * no reference to it afterward. The orchestrator loop:
   *   - asks its LLM for the next move
   *   - dispatches any read-only tool calls directly via MCP
   *   - catches `dispatch_executor` calls and routes them to Executor.run
   *   - feeds structured feedback back to the LLM
   *   - returns when the LLM produces a final tool-free message or caps out
   */
  public async run(userInput: string, options: RunOptions = {}): Promise<RunResult> {
    const emit = options.onEvent ?? (() => {});
    const session = this.runtime.getSession();
    const workspace = this.runtime.getWorkspace();  
    const modelsRegistry = this.runtime.getModelsRegistry();
    const mcpRegistry = this.runtime.getMcpClientRegistry();
    const providersRegistry = this.runtime.getProvidersRegistry();
    const conversation = session.conversation;
    // Resolve a role's tool servers (role → model → models.json `mcp` list),
    // skipping any that are declared but not mounted (e.g. codemcp before
    // ConnectMcpServers lands), so a single scoped client fronts the whole set.
    const clientsFor = (role: string) =>
      modelsRegistry.getValidMcpForModel(role).flatMap((serverName) => {
        const client = mcpRegistry.getClient(serverName);
        return client ? [client] : [];
      });
    const config = await this.runtime.getConfigurationRegistry().getModelsConfiguration()!;
    const contextLoader = this.runtime.getContextLoader();
    const orchestratorContextHash = session.contextHashes ? session.contextHashes["orchestrator"] : null;
    const orchestratorContext = orchestratorContextHash ? await contextLoader.getContextSnapshot(orchestratorContextHash) : null;

    await this.maybeSummarize(conversation, emit, options.signal);
    conversation.push({ role: "user", content: userInput });

    const orchestratorProvider = providersRegistry.getProvider(modelsRegistry.getProviderForRole("orchestrator"));
    const executorProvider = providersRegistry.getProvider(modelsRegistry.getProviderForRole("executor"));

    // The subsessions server was registered at session setup with an undefined
    // coordinator (advertise-only). Re-bind it to THIS turn's live coordinator
    // BEFORE the scoped clients capture the server set — ScopedToolClient snapshots
    // its clients at construction, so a later re-register wouldn't take effect this
    // turn. registerClient is keyed by server name, so this replaces the placeholder
    // in place. Without a coordinator the placeholder stays (calls report
    // "not available"), which keeps sub-sessions one level deep.
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

    const scopedExecutorClient = new ScopedToolClient(clientsFor("executor"), emit);
    const scopedOrchestratorClient = new ScopedToolClient(clientsFor("orchestrator"), emit);

    const executorTools = scopedExecutorClient.listTools();
    const orchestratorTools = scopedOrchestratorClient.listTools();

    const executor = new Executor(this.runtime);

    
    emit({
      type: OrchestratorEventTypes.START,
      data: {
        orchestratorModel: orchestratorProvider.modelId,
        executorModel: executorProvider.modelId,
        orchestratorTools,
        readToolCount: orchestratorTools.length,
        executorToolCount: executorTools.length,
      },
    });

    const systemMessages = this.buildSystemMessages(orchestratorProvider, orchestratorTools, orchestratorContext);
    const workingMessages: ChatMessage[] = [...systemMessages, ...conversation];

    const turnStartIndex = workingMessages.length - 1;

    // Anchor parity with the evaluator. The judge is re-told the ORIGINAL
    // REQUEST verbatim on every call — that is why it stays grounded — while
    // the orchestrator only had the request as one aging line in a transcript
    // dominated by finished goals, which is how a stale goal wins. Re-assert
    // it as the LAST message of every chat call, transient (never pushed to
    // the conversation), so neither context growth nor summarization can
    // bury it.
    const requestAnchor: ChatMessage = {
      role: "system",
      content: modelsRegistry.getAnchorText(userInput),
    };

    const maxIterations = config.orchestration.maxOrchestratorIterations;
    const maxExecutorIterations = config.orchestration.maxExecutorIterationsPerAsk;
    const checkInterval = config.orchestration.validatorCheckIntervalDispatches;
    const maxExecutorDispatchesPerTurn = config.orchestration.maxExecutorDispatchesPerTurn;
    const executorTemperature = config.orchestration.executorTemperature;
    const orchestratorTemperature = config.orchestration.orchestratorTemperature;

    const tracker = new DispatchTracker(maxExecutorDispatchesPerTurn!, checkInterval!);

    const syntheticContext: SyntheticMcpContext = {
      session,
      workspace,
      sandboxRoot: mcpRegistry.sandboxRoot,
      executor,
      coordinator,
      tracker,
      emit,
      signal: options.signal,
      executorMaxIterations: maxExecutorIterations!,
      executorTemperature: executorTemperature!,
    };

    for (let iteration = 1; iteration <= maxIterations!; iteration += 1) {
      // Cooperative stop checkpoint. The abort signal only unwinds awaits
      // that honour it (Ollama's client doesn't, MCP tool calls can't), so
      // the loop re-checks at every safe boundary — bounding stop latency to
      // ONE call instead of the rest of the round.
      if (options.signal?.aborted) {
        throw new Error("turn aborted: user requested stop");
      }

      // Fold in any externally-injected prompts before asking the model. The
      // orchestrator is the sole writer of `conversation`; outside producers
      // enqueue (see InputInbox) and we drain here, at a safe boundary, so a
      // mid-run injection becomes a user turn the next iteration acts on.
      const injectedPrompts = options.pullInjectedPrompts?.() ?? [];
      for (const text of injectedPrompts) {
        const injected: ChatMessage = { role: "user", content: text };
        conversation.push(injected);
        workingMessages.push(injected);
        emit({ type: OrchestratorEventTypes.INJECTED_INPUT, data: { iteration, content: text } });
      }

      emit({ type: OrchestratorEventTypes.ITERATION, data: { iteration, max: maxIterations } });

      let response;
      try {
        response = await orchestratorProvider.chat([...workingMessages, requestAnchor], {
          tools: orchestratorProvider.supportsNativeTools ? orchestratorTools : [],
          temperature: orchestratorTemperature!,
          signal: options.signal,
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Orchestrator (${orchestratorProvider.providerName}:${orchestratorProvider.modelId}) failed at iteration ${iteration}: ${errorMsg}`
        );
      }

      accumulateUsage(session.counters, response.usage);

      const { assistantMessage, toolCalls } = this.normaliseAssistantTurn(orchestratorProvider, response, emit);

      emit({
        type: OrchestratorEventTypes.MESSAGE,
        data: {
          iteration,
          content: assistantMessage.content,
          toolCallCount: toolCalls.length,
          usage: response.usage,
        },
      });

      conversation.push(assistantMessage);
      workingMessages.push(assistantMessage);

      if (toolCalls.length === 0) {
        // Candidate completion. Gate it through the evaluator: the turn only
        // ends on a SATISFIED verdict. CONTINUE and UNSATISFIED both keep the
        // loop running, with different steering.
        const verdict = await this.evaluateCompletion(
          userInput,
          assistantMessage.content,
          workingMessages.slice(turnStartIndex),
          emit,
          options.signal
        );

        if (verdict.state === "satisfied") {
          return {
            finalMessage: assistantMessage,
            iterations: iteration,
            dispatches: tracker.count,
            outcome: "satisfied",
          };
        }

        if (verdict.state === "awaiting-input") {
          return {
            finalMessage: assistantMessage,
            iterations: iteration,
            dispatches: tracker.count,
            outcome: "satisfied",
          };
        }

        // Nudges quote the request verbatim: a bare "the request" resolves
        // against whatever goal is most salient in the transcript, which after
        // a long session is usually a FINISHED one.
        const nudge: ChatMessage = {
          role: "user",
          content:
            verdict.state === "continue"
              ? `EVALUATOR: on track — ${verdict.reason}\n` +
                `The request for THIS turn is exactly: «${userInput}»\n` +
                "Keep going: take the next concrete action toward fulfilling it. " +
                "Do not stop until it is complete."
              : `EVALUATOR: off track — ${verdict.reason}\n` +
                `The request for THIS turn is exactly: «${userInput}»\n` +
                "Stop repeating what isn't working and change your approach. Re-check this " +
                "request and the current workspace state, then take a different next action.",
        };
        conversation.push(nudge);
        workingMessages.push(nudge);
        continue;
      }

      const toolMessages: ChatMessage[] = [];

      for (const call of toolCalls) {
        // Stop between tool calls too — an executor dispatch can be the
        // longest single await in the turn.
        if (options.signal?.aborted) {
          throw new Error("turn aborted: user requested stop");
        }
        // Executor dispatch. Intercepted before MCP and routed to the executor
        // sub-agent. Returns the same ToolExecutionResult shape a real MCP tool
        // would, so it is wrapped into a role:"tool" message by the identical
        // code path below.
        if (executorTools.find(e => e.name == call.name)) {
          // Executor handlers self-mark their content (e.g. [dispatch-error]),
          // so it is wrapped verbatim.
          const result = await scopedExecutorClient.callTool(call.name, call.arguments);
          toolMessages.push(wrapToolResult(call, result.content));
          continue;
        }

        // Read-only MCP tool. Dispatch directly (ScopedToolClient emits tool-call/tool-result).
        const execution: ToolExecutionResult = await scopedOrchestratorClient.callTool(call.name, call.arguments);

        toolMessages.push(
          wrapToolResult(call, execution.isError ? `[tool-error] ${execution.content}` : execution.content)
        );
      }

      conversation.push(...toolMessages);
      workingMessages.push(...toolMessages);

      // Periodic progress gate. Every N successful dispatches, run the
      // validator mid-flight (not only at completion) so a no-progress streak
      // that never stops calling tools still gets caught. Only an off-track
      // verdict steers; CONTINUE/SATISFIED let the loop run on, since a
      // lenient mid-loop judge must not terminate the turn early.
      if (tracker.dueForPeriodicCheck()) {
        const verdict = await this.evaluateCompletion(
          userInput,
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
              `The request for THIS turn is exactly: «${userInput}»\n` +
              "Stop repeating what isn't working and change your approach. Re-check this " +
              "request and the current workspace state, then take a different next action.",
          };
          conversation.push(nudge);
          workingMessages.push(nudge);
        }
      }
    }

    const truncationNotice: ChatMessage = {
      role: "assistant",
      content:
        `ORCHESTRATOR: hit iteration cap of ${maxIterations} without a final answer. ` +
        "Try a narrower request or raise maxOrchestratorIterations in models.json.",
    };
    conversation.push(truncationNotice);
    emit({
      type: OrchestratorEventTypes.WARNING,
      data: { message: "orchestrator hit iteration cap", iterations: maxIterations },
    });
    return {
      finalMessage: truncationNotice,
      iterations: maxIterations!,
      dispatches: tracker.count,
      outcome: "capped",
    };
  }

  // --------------------------------------------------------------------------

  /**
   * Fold the older portion of the conversation into a single summary
   * `system` message when the transcript grows past the configured
   * threshold. Runs at the top of each user turn, BEFORE the new user
   * message is appended, so the summarizer only sees prior completed
   * exchanges.
   *
   * Mutates the passed `conversation` array in place. The tail boundary is
   * snapped forward to avoid orphaning a `role:"tool"` message from its
   * parent assistant tool-call turn.
   */
  private async maybeSummarize(
    conversation: ChatMessage[],
    emit: RunnerListener,
    signal?: AbortSignal
  ): Promise<void> {
    var config = await this.runtime.getConfigurationRegistry().getModelsConfiguration();
    const threshold = config.orchestration.summarizeAtMessages!
    if (conversation.length <= threshold) return;

    const desiredKeep = config.orchestration.summarizerKeepLastN!;
    const tailStart = findCleanTailStart(conversation, desiredKeep);
    if (tailStart === 0) return;

    const prefix = conversation.slice(0, tailStart);
    const tail = conversation.slice(tailStart);

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

    conversation.length = 0;
    conversation.push(summaryMessage, ...tail);

    emit({
      type: OrchestratorEventTypes.SUMMARIZATION,
      data: {
        summarizedCount: prefix.length,
        keptCount: tail.length,
        summaryChars: summaryText.length,
      },
    });
  }

  /**
   * Run the completion gate. Asks the evaluator whether `proposedAnswer`,
   * together with the work in `transcript`, fulfils the original question.
   * Fails OPEN: any evaluator error is treated as satisfied so a flaky
   * judge can never trap the user in an endless loop.
   */
  private async evaluateCompletion(
    question: string,
    proposedAnswer: string,
    transcript: ChatMessage[],
    emit: OrchestratorListener,
    signal?: AbortSignal
  ): Promise<EvaluationVerdict> {
    emit({ type: OrchestratorEventTypes.EVALUATION_START, data: {} });

    try {
       var config = await this.runtime.getConfigurationRegistry().getModelsConfiguration();
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
    orchestrator: LLMProvider,
    visibleTools: ToolDescriptor[],
    context?: ContextSnapshot | null
  ): ChatMessage[] {
    const messages: ChatMessage[] = [];

    if (context) {
      messages.push({
        role: "system",
        content:
          `Treat this as standing direction from the user; follow it unless ` +
          `a specific request overrides it.\n\n` +
          context.projectContext,
      });
    }

    const basePrompt = ORCHESTRATOR_SYSTEM_PROMPT;
    const promptedInstructions = orchestrator.supportsNativeTools
      ? ""
      : buildPromptedToolInstructions(visibleTools);

    messages.push({
      role: "system",
      content: basePrompt + promptedInstructions,
    });

    return messages;
  }

  private normaliseAssistantTurn(
    orchestrator: LLMProvider,
    response: ChatResponse,
    emit: OrchestratorListener
  ): { assistantMessage: ChatMessage; toolCalls: ToolCall[] } {
    if (orchestrator.supportsNativeTools) {
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
            model: orchestrator.modelId,
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
// Fold one chat response's token usage into the session's running tally.
// Defensive `?? 0` on the counters covers sessions persisted before the token
// fields existed; on the usage side it covers providers (or requests) that
// report no caching. Mutates in place — the counters ride along on the Session
// the caller already persists.
// ---------------------------------------------------------------------------

function accumulateUsage(counters: SessionCounters, usage: ChatResponse["usage"]): void {
  if (!usage) return;
  counters.inputTokens = (counters.inputTokens ?? 0) + (usage.inputTokens ?? 0);
  counters.outputTokens = (counters.outputTokens ?? 0) + (usage.outputTokens ?? 0);
  counters.cacheReadInputTokens =
    (counters.cacheReadInputTokens ?? 0) + (usage.cacheReadInputTokens ?? 0);
  counters.cacheCreationInputTokens =
    (counters.cacheCreationInputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0);
}

// ---------------------------------------------------------------------------
// Wrap a tool result (synthetic OR real MCP) into a role:"tool" message. Both
// kinds produce the same ToolExecutionResult shape, so this single path keeps
// their message construction identical — the only difference is interception
// upstream, and how each branch pre-formats `content` (real MCP errors are
// tagged `[tool-error]`; synthetic handlers carry their own domain markers).
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
 *     user turn or a functionResponse (HTTP 400: "function call turn comes
 *     immediately after a user turn or after a function response turn"). After
 *     summarization the summary is a `system` message that lands in
 *     systemInstruction, not contents, so the tail's first turn really is
 *     contents[0] — it cannot be a bare tool-call.
 *
 * Starts from the desired window (`messages.length - desiredTailLen`) and walks
 * forward until such a head is found. If none remains, returns `messages.length`
 * so the caller summarizes everything.
 */
function findCleanTailStart(messages: ChatMessage[], desiredTailLen: number): number {
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
