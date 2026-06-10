import { Executor } from "./executor.js";
import type { ToolExecutionResult } from "./mcp-client.js";
import type {
  ChatMessage,
  ChatResponse,
  LLMProvider,
  ToolCall,
  ToolDescriptor,
} from "./providers/provider.js";
import { ORCHESTRATOR_SYSTEM_PROMPT } from "./system-prompt.js";
import {
  buildPromptedToolInstructions,
  extractPromptedToolCalls,
} from "./tool-adapter.js";
import { Summarizer, buildSummaryMessage } from "./summarizer.js";
import { Evaluator, type EvaluationVerdict } from "./evaluator.js";
import { ScopedToolClient } from "./scoped-tool-client.js";
import type { SessionCounters } from "./session.js";
import type { SubSessionCoordinator } from "./subsession.js";
import type { Workspace } from "./workspace-registry.js";
import {
  DispatchTracker,
  buildExecutorRegistry,
  type SyntheticMcpContext,
} from "./synthetic-mcp/index.js";
import { createExcelMcpServer } from "./synthetic-mcp/excel-server.js";
import { createSubsessionsMcpServer } from "./synthetic-mcp/subsessions-server.js";
import type { AgentRuntimeQueryable } from "./runtime/types.js";

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

export interface OrchestratorEvent {
  type:
    | "orchestrator-start"
    | "orchestrator-iteration"
    | "orchestrator-message"
    | "tool-call"
    | "tool-result"
    | "dispatch-start"
    | "dispatch-feedback"
    | "executor-event"
    | "final-message"
    | "summarization"
    | "evaluation-start"
    | "evaluation-verdict"
    | "injected-input"
    | "subsession-start"
    | "subsession-status"
    | "subsession-finalize"
    | "warning";
  data: Record<string, unknown>;
}

export type OrchestratorListener = (event: OrchestratorEvent) => void;

export interface RunOptions {
  signal?: AbortSignal;
  onEvent?: OrchestratorListener;
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
    const registry = this.runtime.getRegistry();
    const mcpClient = this.runtime.getMcpClient();
    const visibleTools = this.runtime.getToolDescriptors();

    const conversation = session.conversation;

    await this.maybeSummarize(conversation, emit, options.signal);

    conversation.push({ role: "user", content: userInput });

    const orchestratorProvider = registry.getProviderForRole("orchestrator");
    const executorProvider = registry.getProviderForRole("executor");

    // Get executor tools for the executor to use (not for display)
    const executorTools = registry.filterToolsByServerWhitelist(
      "executor",
      mcpClient.listTools()
    );

    // Build executor registry for routing dispatch_executor calls
    const executorRegistry = buildExecutorRegistry(executorTools);

    // Filter visible tools by orchestrator model's whitelist
    const modelFilteredTools = registry.filterToolsByServerWhitelist("orchestrator", visibleTools);

    // Bind every tool call this turn to the session's workspace segment. The
    // executor's mutations and the orchestrator's own read calls both go through
    // this clamp; fsmcp stays workspace-agnostic, the limiting lives here.
    const scopedTools = new ScopedToolClient(mcpClient, workspace.workspaceId);

    const executor = new Executor(executorProvider, scopedTools, executorTools);

    // Count read-only tools (all visible tools minus dispatch_executor and synthetic tools)
    const readToolCount = modelFilteredTools.filter((t) => !executorRegistry.has(t.name)).length;

    emit({
      type: "orchestrator-start",
      data: {
        orchestratorModel: orchestratorProvider.modelId,
        executorModel: executorProvider.modelId,
        readToolCount,
        executorToolCount: executorTools.length,
      },
    });

    const systemMessages = this.buildSystemMessages(orchestratorProvider, modelFilteredTools, workspace);
    const workingMessages: ChatMessage[] = [...systemMessages, ...conversation];

    // The evaluator judges only THIS turn — the current user request and the
    // work done in response to it — not the whole session. `userInput` was just
    // pushed onto `conversation`, so it is the last element of workingMessages;
    // everything from here on is appended, so this index bounds the turn for the
    // rest of the loop. (Summarization runs only at the top of a turn, before
    // the user push, so it can never shift this index mid-loop.)
    const turnStartIndex = workingMessages.length - 1;

    const maxIterations = registry.orchestration.maxOrchestratorIterations;
    const maxExecutorIterations = registry.orchestration.maxExecutorIterationsPerAsk;
    const checkInterval = registry.orchestration.validatorCheckIntervalDispatches;

    // Per-turn dispatch accounting (cap, duplicate guard, periodic-check gate),
    // owned by the tracker and queried by the dispatch tool and the loop.
    const tracker = new DispatchTracker(
      registry.orchestration.maxExecutorDispatchesPerTurn,
      checkInterval
    );

    // Context every synthetic-tool handler receives for this turn.
    const coordinator = options.coordinator;
    const syntheticContext: SyntheticMcpContext = {
      session,
      workspace,
      sandboxRoot: mcpClient.sandboxRoot,
      executor,
      coordinator,
      tracker,
      emit,
      signal: options.signal,
      executorMaxIterations: maxExecutorIterations,
      executorTemperature: registry.orchestration.executorTemperature,
    };

    // Create a fresh Excel MCP server for this turn with the current context.
    // It's registered as an in-process connection so Excel tools are routed
    // through McpClient.callTool alongside fsmcp and other MCP servers.
    const excelServer = createExcelMcpServer(syntheticContext);
    await mcpClient.registerRuntimeConnection(excelServer.serverName, excelServer.client);

    // Create a subsessions server only if a coordinator is wired in. Like Excel,
    // it needs per-turn context. Subsessions are one level deep so detached runs
    // don't have a coordinator and therefore no subsession tools.
    if (coordinator) {
      const subsessionsServer = createSubsessionsMcpServer(syntheticContext);
      await mcpClient.registerRuntimeConnection(subsessionsServer.serverName, subsessionsServer.client);
    }

    for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
      // Fold in any externally-injected prompts before asking the model. The
      // orchestrator is the sole writer of `conversation`; outside producers
      // enqueue (see InputInbox) and we drain here, at a safe boundary, so a
      // mid-run injection becomes a user turn the next iteration acts on.
      const injectedPrompts = options.pullInjectedPrompts?.() ?? [];
      for (const text of injectedPrompts) {
        const injected: ChatMessage = { role: "user", content: text };
        conversation.push(injected);
        workingMessages.push(injected);
        emit({ type: "injected-input", data: { iteration, content: text } });
      }

      emit({ type: "orchestrator-iteration", data: { iteration, max: maxIterations } });

      const response = await orchestratorProvider.chat(workingMessages, {
        tools: orchestratorProvider.supportsNativeTools ? modelFilteredTools : [],
        temperature: registry.orchestration.orchestratorTemperature,
        signal: options.signal,
      });

      accumulateUsage(session.counters, response.usage);

      const { assistantMessage, toolCalls } = this.normaliseAssistantTurn(orchestratorProvider, response, emit);

      emit({
        type: "orchestrator-message",
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

        const nudge: ChatMessage = {
          role: "user",
          content:
            verdict.state === "continue"
              ? `EVALUATOR: on track — ${verdict.reason}\n` +
                "Keep going: take the next concrete action toward fulfilling the request. " +
                "Do not stop until it is complete."
              : `EVALUATOR: off track — ${verdict.reason}\n` +
                "Stop repeating what isn't working and change your approach. Re-check the " +
                "request and the current workspace state, then take a different next action.",
        };
        conversation.push(nudge);
        workingMessages.push(nudge);
        continue;
      }

      const toolMessages: ChatMessage[] = [];

      for (const call of toolCalls) {
        // Executor dispatch. Intercepted before MCP and routed to the executor
        // sub-agent. Returns the same ToolExecutionResult shape a real MCP tool
        // would, so it is wrapped into a role:"tool" message by the identical
        // code path below.
        if (executorRegistry.has(call.name)) {
          // Executor handlers self-mark their content (e.g. [dispatch-error]),
          // so it is wrapped verbatim.
          const result = await executorRegistry.dispatch(call.name, call.arguments, syntheticContext);
          toolMessages.push(wrapToolResult(call, result.content));
          continue;
        }

        // Read-only MCP tool. Dispatch directly.
        emit({
          type: "tool-call",
          data: { id: call.id, name: call.name, arguments: call.arguments },
        });

        const execution: ToolExecutionResult = await scopedTools.callTool(call.name, call.arguments);

        emit({
          type: "tool-result",
          data: {
            id: call.id,
            name: call.name,
            isError: execution.isError,
            contentPreview: execution.content.slice(0, 400),
          },
        });

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
              "Stop repeating what isn't working and change your approach. Re-check the " +
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
      type: "warning",
      data: { message: "orchestrator hit iteration cap", iterations: maxIterations },
    });
    return {
      finalMessage: truncationNotice,
      iterations: maxIterations,
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
    emit: OrchestratorListener,
    signal?: AbortSignal
  ): Promise<void> {
    const threshold = this.runtime.getRegistry().orchestration.summarizeAtMessages;
    if (conversation.length <= threshold) return;

    const desiredKeep = this.runtime.getRegistry().orchestration.summarizerKeepLastN;
    const tailStart = findCleanTailStart(conversation, desiredKeep);
    if (tailStart === 0) return;

    const prefix = conversation.slice(0, tailStart);
    const tail = conversation.slice(tailStart);

    let summaryText: string;
    try {
      const summarizer = new Summarizer(this.runtime.getRegistry().getSummarizerProvider());
      summaryText = await summarizer.summarize(prefix, { signal });
    } catch (err) {
      emit({
        type: "warning",
        data: { message: `summarization failed: ${(err as Error).message}` },
      });
      return;
    }

    const summaryMessage = buildSummaryMessage(summaryText, prefix.length);

    conversation.length = 0;
    conversation.push(summaryMessage, ...tail);

    emit({
      type: "summarization",
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
    emit({ type: "evaluation-start", data: {} });

    try {
      const evaluator = new Evaluator(this.runtime.getRegistry().getEvaluatorProvider());
      const verdict = await evaluator.evaluate(
        { question, proposedAnswer, transcript },
        { signal, temperature: this.runtime.getRegistry().orchestration.evaluatorTemperature }
      );
      emit({
        type: "evaluation-verdict",
        data: { state: verdict.state, reason: verdict.reason },
      });
      return verdict;
    } catch (err) {
      // Fail open — never trap the user because the judge errored.
      emit({
        type: "warning",
        data: { message: `evaluation failed, treating as satisfied: ${(err as Error).message}` },
      });
      return { state: "satisfied", reason: "evaluator error; defaulting to satisfied" };
    }
  }

  private buildSystemMessages(
    orchestrator: LLMProvider,
    visibleTools: ToolDescriptor[],
    workspace: Workspace
  ): ChatMessage[] {
    const messages: ChatMessage[] = [];

    if (workspace.projectContext) {
      messages.push({
        role: "system",
        content:
          `Project context (from ${workspace.projectContext.sourcePath}). ` +
          `Treat this as standing direction from the user; follow it unless ` +
          `a specific request overrides it.\n\n` +
          workspace.projectContext.content,
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
          type: "warning",
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
