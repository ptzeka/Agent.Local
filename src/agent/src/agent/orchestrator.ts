import { Executor } from "./executor.js";
import type { McpToolClient, ToolExecutionResult } from "./mcp-client.js";
import type { ModelRegistry } from "./model-registry.js";
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
import type { Session } from "./session.js";
import type { SubSessionCoordinator } from "./subsession.js";
import type { Workspace } from "./workspace-registry.js";
import {
  DispatchTracker,
  buildSyntheticTools,
  type SyntheticToolContext,
} from "./synthetic-tools/index.js";

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
}

/**
 * The capability the SessionManager needs to drive a sub-session: run a session
 * to completion. Declared here and satisfied structurally by `Orchestrator`, so
 * the manager depends on this narrow contract rather than the concrete class —
 * keeping the orchestrator ⇄ manager construction acyclic.
 */
export interface SessionRunner {
  run(
    session: Session,
    workspace: Workspace,
    userInput: string,
    options?: RunOptions
  ): Promise<RunResult>;
}

export class Orchestrator {
  constructor(
    private readonly registry: ModelRegistry,
    private readonly tools: McpToolClient
  ) {}

  /**
   * Run one user turn end-to-end against the given session and workspace.
   * Mutates `session.conversation` in place (the turn's work product); holds
   * no reference to it afterward. The orchestrator loop:
   *   - asks its LLM for the next move
   *   - dispatches any read-only tool calls directly via MCP
   *   - catches `dispatch_executor` calls and routes them to Executor.run
   *   - feeds structured feedback back to the LLM
   *   - returns when the LLM produces a final tool-free message or caps out
   */
  public async run(
    session: Session,
    workspace: Workspace,
    userInput: string,
    options: RunOptions = {}
  ): Promise<RunResult> {
    const emit = options.onEvent ?? (() => {});
    const conversation = session.conversation;

    await this.maybeSummarize(conversation, emit, options.signal);

    conversation.push({ role: "user", content: userInput });

    const orchestratorProvider = this.registry.getProviderForRole("orchestrator");
    const executorProvider = this.registry.getProviderForRole("executor");

    const orchestratorTools = this.tools.listToolsForOrchestrator();
    const executorTools = this.tools.listToolsForExecutor();

    const coordinator = options.coordinator;
    // Synthetic tools look like real MCP tools to the LLM (descriptor + a
    // callTool that returns a ToolExecutionResult), but the orchestrator
    // intercepts them and routes to the executor / coordinator. The sub-session
    // tools are advertised only when a coordinator is wired in — detached
    // sub-session runs get none, enforcing the one-level-deep guard at source.
    const synthetic = buildSyntheticTools({
      executorTools,
      includeSubSessions: Boolean(coordinator),
    });
    const visibleTools: ToolDescriptor[] = [...orchestratorTools, ...synthetic.listDescriptors()];

    // Bind every tool call this turn to the session's workspace segment. The
    // executor's mutations and the orchestrator's own read calls both go through
    // this clamp; fsmcp stays workspace-agnostic, the limiting lives here.
    const scopedTools = new ScopedToolClient(this.tools, workspace.workspaceId);

    const executor = new Executor(executorProvider, scopedTools, executorTools);

    emit({
      type: "orchestrator-start",
      data: {
        orchestratorModel: orchestratorProvider.modelId,
        executorModel: executorProvider.modelId,
        readToolCount: orchestratorTools.length,
        executorToolCount: executorTools.length,
      },
    });

    const systemMessages = this.buildSystemMessages(orchestratorProvider, visibleTools, workspace);
    const workingMessages: ChatMessage[] = [...systemMessages, ...conversation];

    // The evaluator judges only THIS turn — the current user request and the
    // work done in response to it — not the whole session. `userInput` was just
    // pushed onto `conversation`, so it is the last element of workingMessages;
    // everything from here on is appended, so this index bounds the turn for the
    // rest of the loop. (Summarization runs only at the top of a turn, before
    // the user push, so it can never shift this index mid-loop.)
    const turnStartIndex = workingMessages.length - 1;

    const maxIterations = this.registry.orchestration.maxOrchestratorIterations;
    const maxExecutorIterations = this.registry.orchestration.maxExecutorIterationsPerAsk;
    const checkInterval = this.registry.orchestration.validatorCheckIntervalDispatches;

    // Per-turn dispatch accounting (cap, duplicate guard, periodic-check gate),
    // owned by the tracker and queried by the dispatch tool and the loop.
    const tracker = new DispatchTracker(
      this.registry.orchestration.maxExecutorDispatchesPerTurn,
      checkInterval
    );

    // Context every synthetic-tool handler receives for this turn.
    const syntheticContext: SyntheticToolContext = {
      session,
      workspace,
      sandboxRoot: this.tools.sandboxRoot,
      executor,
      coordinator,
      tracker,
      emit,
      signal: options.signal,
      executorMaxIterations: maxExecutorIterations,
      executorTemperature: this.registry.orchestration.executorTemperature,
    };

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
        tools: orchestratorProvider.supportsNativeTools ? visibleTools : [],
        temperature: this.registry.orchestration.orchestratorTemperature,
        signal: options.signal,
      });

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
          return { finalMessage: assistantMessage, iterations: iteration, dispatches: tracker.count };
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
        // Synthetic tool. Intercepted before MCP and routed internally (to the
        // executor or the sub-session coordinator). It returns the same
        // ToolExecutionResult shape a real MCP tool would, so it is wrapped into
        // a role:"tool" message by the identical code path below.
        if (synthetic.has(call.name)) {
          // Synthetic handlers self-mark their content (e.g. [dispatch-error],
          // [subsession-error], EVALUATOR steers), so it is wrapped verbatim.
          const result = await synthetic.dispatch(call.name, call.arguments, syntheticContext);
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
    return { finalMessage: truncationNotice, iterations: maxIterations, dispatches: tracker.count };
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
    const threshold = this.registry.orchestration.summarizeAtMessages;
    if (conversation.length <= threshold) return;

    const desiredKeep = this.registry.orchestration.summarizerKeepLastN;
    const tailStart = findCleanTailStart(conversation, desiredKeep);
    if (tailStart === 0) return;

    const prefix = conversation.slice(0, tailStart);
    const tail = conversation.slice(tailStart);

    let summaryText: string;
    try {
      const summarizer = new Summarizer(this.registry.getSummarizerProvider());
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
      const evaluator = new Evaluator(this.registry.getEvaluatorProvider());
      const verdict = await evaluator.evaluate(
        { question, proposedAnswer, transcript },
        { signal, temperature: this.registry.orchestration.evaluatorTemperature }
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
 * Find a tail-start index that does NOT begin with a `role:"tool"`
 * message. Tool messages must follow an assistant message that called
 * them — keeping a tool message without its parent would produce an
 * orphan and break providers that validate tool_call_id pairing.
 *
 * Starts from the desired window (`messages.length - desiredTailLen`)
 * and walks forward until a non-tool message is found. If the entire
 * remaining slice is tool messages, returns `messages.length` so the
 * caller summarizes everything.
 */
function findCleanTailStart(messages: ChatMessage[], desiredTailLen: number): number {
  const initial = Math.max(0, messages.length - desiredTailLen);
  for (let i = initial; i < messages.length; i += 1) {
    if (messages[i].role !== "tool") return i;
  }
  return messages.length;
}
