import { Executor, type ExecutorAsk, type ExecutorEvent, type ExecutorFeedback } from "./executor.js";
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
import type { SubSessionCoordinator, SubSessionSnapshot } from "./subsession.js";
import type { Workspace } from "./workspace-registry.js";

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

const DISPATCH_TOOL_NAME = "dispatch_executor";

// Synthetic sub-session tools. Like dispatch_executor, the orchestrator's LLM
// sees these but the orchestrator intercepts the calls before they reach MCP
// and routes them to the SubSessionCoordinator.
const CREATE_SUBSESSION_TOOL = "create_subsession";
const SUBSESSION_STATUS_TOOL = "get_subsession_status";
const LIST_SUBSESSIONS_TOOL = "list_subsessions";
const FINALIZE_SUBSESSION_TOOL = "finalize_subsession";

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
    const dispatchDescriptor = buildDispatchToolDescriptor(executorTools);
    const visibleTools: ToolDescriptor[] = [...orchestratorTools, dispatchDescriptor];
    // Only advertise the sub-session tools when a coordinator is wired in. The
    // detached sub-session runs themselves get no coordinator, so they never see
    // these tools — enforcing the one-level-deep guard at the source.
    if (coordinator) {
      visibleTools.push(...buildSessionToolDescriptors());
    }

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
    const maxDispatches = this.registry.orchestration.maxExecutorDispatchesPerTurn;
    const maxExecutorIterations = this.registry.orchestration.maxExecutorIterationsPerAsk;
    const checkInterval = this.registry.orchestration.validatorCheckIntervalDispatches;

    let dispatches = 0;
    // Signatures (tool + stable-stringified args) of dispatches that already
    // SUCCEEDED this turn. A re-dispatch of an identical, already-succeeded
    // mutation is a no-progress loop — the validator stops it and forces a
    // rethink instead of re-running the executor.
    const succeededSignatures = new Set<string>();
    // Dispatches since the last periodic validator check. Drives the
    // every-N-dispatches progress gate.
    let dispatchesSinceCheck = 0;

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
          return { finalMessage: assistantMessage, iterations: iteration, dispatches };
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
        if (call.name === DISPATCH_TOOL_NAME) {
          if (dispatches >= maxDispatches) {
            toolMessages.push({
              role: "tool",
              content: `[dispatch-blocked] dispatch cap of ${maxDispatches} per turn reached`,
              toolCallId: call.id,
              toolName: DISPATCH_TOOL_NAME,
            });
            emit({
              type: "warning",
              data: { message: "dispatch cap reached", maxDispatches },
            });
            continue;
          }
          dispatches += 1;

          const ask = parseDispatchAsk(call.arguments, executorTools);
          if (!ask.ok) {
            toolMessages.push({
              role: "tool",
              content: `[dispatch-error] ${ask.reason}`,
              toolCallId: call.id,
              toolName: DISPATCH_TOOL_NAME,
            });
            emit({ type: "warning", data: { message: ask.reason } });
            continue;
          }

          // Duplicate guard. If this exact mutation already landed this turn,
          // re-running it makes no progress — the validator intervenes with a
          // stop-and-rethink steer instead of dispatching the executor again.
          // (The dispatch still counted against maxDispatches above, so a hard
          // loop also burns down toward the cap as a backstop.)
          const signature = dispatchSignature(ask.value);
          if (succeededSignatures.has(signature)) {
            toolMessages.push({
              role: "tool",
              content:
                `EVALUATOR: STOP — duplicate dispatch. You already ran this exact ` +
                `mutation (tool=${ask.value.tool}) successfully this turn; repeating ` +
                `it changes nothing. Re-read the request and the current workspace ` +
                `state, then take a DIFFERENT next action — or, if the task is done, ` +
                `produce a final answer with NO tool calls.`,
              toolCallId: call.id,
              toolName: DISPATCH_TOOL_NAME,
            });
            emit({
              type: "warning",
              data: { message: "duplicate dispatch blocked by validator", tool: ask.value.tool },
            });
            continue;
          }

          emit({
            type: "dispatch-start",
            data: { tool: ask.value.tool, intent: ask.value.intent, args: ask.value.args },
          });

          const feedback = await executor.run(ask.value, {
            signal: options.signal,
            maxIterations: maxExecutorIterations,
            temperature: this.registry.orchestration.executorTemperature,
            onEvent: (event: ExecutorEvent) =>
              emit({ type: "executor-event", data: { ...event.data, kind: event.type } }),
          });

          emit({
            type: "dispatch-feedback",
            data: {
              ok: feedback.ok,
              ack: feedback.ack,
              evidence: feedback.evidence,
              deterministicVerdict: feedback.deterministicVerdict,
              iterations: feedback.iterations,
            },
          });

          toolMessages.push({
            role: "tool",
            content: formatFeedbackForOrchestrator(feedback),
            toolCallId: call.id,
            toolName: DISPATCH_TOOL_NAME,
          });

          // Only a genuinely-successful mutation counts as progress: record its
          // signature (so a later identical re-dispatch is caught above) and
          // advance the periodic-check counter.
          if (feedback.ok) {
            succeededSignatures.add(signature);
            dispatchesSinceCheck += 1;
          }
          continue;
        }

        // Synthetic sub-session tools. Intercepted before MCP and routed to the
        // coordinator. parentSessionId is always THIS session's id — the LLM
        // never supplies it, so it can't be spoofed or get out of sync.
        if (
          call.name === CREATE_SUBSESSION_TOOL ||
          call.name === SUBSESSION_STATUS_TOOL ||
          call.name === LIST_SUBSESSIONS_TOOL ||
          call.name === FINALIZE_SUBSESSION_TOOL
        ) {
          toolMessages.push(
            await this.handleSubSessionCall(call, session, workspace, coordinator, emit, options.signal)
          );
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

        toolMessages.push({
          role: "tool",
          content: execution.isError ? `[tool-error] ${execution.content}` : execution.content,
          toolCallId: call.id,
          toolName: call.name,
        });
      }

      conversation.push(...toolMessages);
      workingMessages.push(...toolMessages);

      // Periodic progress gate. Every N successful dispatches, run the
      // validator mid-flight (not only at completion) so a no-progress streak
      // that never stops calling tools still gets caught. Only an off-track
      // verdict steers; CONTINUE/SATISFIED let the loop run on, since a
      // lenient mid-loop judge must not terminate the turn early.
      if (checkInterval > 0 && dispatchesSinceCheck >= checkInterval) {
        dispatchesSinceCheck = 0;
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
    return { finalMessage: truncationNotice, iterations: maxIterations, dispatches };
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

  /**
   * Handle a synthetic sub-session tool call. Validates args, auto-injects this
   * session's id as the parent, routes to the coordinator, and shapes the
   * snapshot (or a `[subsession-error]`) into the `role:"tool"` reply.
   */
  private async handleSubSessionCall(
    call: ToolCall,
    session: Session,
    workspace: Workspace,
    coordinator: SubSessionCoordinator | undefined,
    emit: OrchestratorListener,
    signal?: AbortSignal
  ): Promise<ChatMessage> {
    const toolError = (reason: string): ChatMessage => ({
      role: "tool",
      content: `[subsession-error] ${reason}`,
      toolCallId: call.id,
      toolName: call.name,
    });

    if (!coordinator) {
      return toolError("sub-sessions are not available in this run");
    }

    const args = call.arguments;

    if (call.name === CREATE_SUBSESSION_TOOL) {
      const intent = args.intent;
      if (typeof intent !== "string" || intent.trim().length === 0) {
        return toolError("create_subsession.intent must be a non-empty string");
      }
      const context = typeof args.context === "string" ? args.context : undefined;
      const result = coordinator.createSubSession({
        parentSessionId: session.sessionId,
        workspace,
        intent,
        context,
      });

      // Rejected by the per-parent cap — surface as a tool error so the model
      // waits on or finalizes an existing child instead of retrying blindly.
      if (result.outcome === "rejected" || !result.snapshot) {
        emit({ type: "subsession-start", data: { intent, outcome: "rejected", reason: result.reason } });
        return toolError(result.reason ?? "sub-session creation rejected");
      }

      // created or reused — both return the live child's snapshot. The reused
      // note tells the model it already has this work in flight.
      emit({
        type: "subsession-start",
        data: { subSessionId: result.snapshot.subSessionId, intent, outcome: result.outcome },
      });
      const prefix = result.outcome === "reused" ? `[subsession-reused] ${result.reason}\n` : "";
      return {
        role: "tool",
        content: prefix + JSON.stringify(result.snapshot, null, 2),
        toolCallId: call.id,
        toolName: call.name,
      };
    }

    if (call.name === LIST_SUBSESSIONS_TOOL) {
      const snapshots = coordinator.list(session.sessionId);
      emit({ type: "subsession-status", data: { count: snapshots.length } });
      return {
        role: "tool",
        content: JSON.stringify({ count: snapshots.length, subSessions: snapshots }, null, 2),
        toolCallId: call.id,
        toolName: call.name,
      };
    }

    // get_status and finalize both key off a subSessionId.
    const subSessionId = args.subSessionId;
    if (typeof subSessionId !== "string" || subSessionId.length === 0) {
      return toolError(`${call.name}.subSessionId must be a non-empty string`);
    }

    if (call.name === SUBSESSION_STATUS_TOOL) {
      const result = await coordinator.getStatus(session.sessionId, subSessionId, signal);
      if (!result) return toolError(`unknown subSessionId "${subSessionId}" for this session`);
      emit({
        type: "subsession-status",
        data: { subSessionId, status: result.snapshot.status, backoffMs: result.backoffMs },
      });
      // When a backoff was applied the status hasn't changed since last poll —
      // tell the model to stop hammering and do other work before re-checking.
      const note =
        result.backoffMs > 0
          ? `[backoff ${result.backoffMs}ms — status unchanged ("${result.snapshot.status}") since your last check; ` +
            `do other useful work or finalize it instead of polling again immediately]\n`
          : "";
      return {
        role: "tool",
        content: note + JSON.stringify(result.snapshot, null, 2),
        toolCallId: call.id,
        toolName: call.name,
      };
    }

    // FINALIZE_SUBSESSION_TOOL
    const finalStatus =
      args.finalStatus === "done" || args.finalStatus === "error" ? args.finalStatus : undefined;
    const snapshot = coordinator.finalize(session.sessionId, subSessionId, finalStatus);
    if (!snapshot) return toolError(`unknown subSessionId "${subSessionId}" for this session`);
    emit({ type: "subsession-finalize", data: { subSessionId, status: snapshot.status } });
    return this.subSessionResult(call, snapshot);
  }

  private subSessionResult(call: ToolCall, snapshot: SubSessionSnapshot): ChatMessage {
    return {
      role: "tool",
      content: JSON.stringify(snapshot, null, 2),
      toolCallId: call.id,
      toolName: call.name,
    };
  }
}

// ---------------------------------------------------------------------------
// dispatch_executor — synthetic tool the orchestrator's LLM sees but that is
// intercepted by the orchestrator itself before ever reaching MCP.
// ---------------------------------------------------------------------------

function buildDispatchToolDescriptor(executorTools: ToolDescriptor[]): ToolDescriptor {
  const executorToolNames = executorTools.map((t) => t.name).sort();
  const description = [
    "Spawn the EXECUTOR sub-agent to perform exactly one mutation.",
    "This is the ONLY way the orchestrator can change state — write_file,",
    "edit_file, and shell tools are NOT directly callable.",
    "",
    `Allowed values for "tool" (executor-side tool names):`,
    ...executorToolNames.map((n) => `  - ${n}`),
    "",
    "The executor will ACK the ask, run the tool, independently re-read or",
    "check the result, and return a structured feedback message that includes",
    "both its own RESULT line and a deterministic verdict computed in code.",
  ].join("\n");

  return {
    name: DISPATCH_TOOL_NAME,
    description,
    inputSchema: {
      type: "object",
      required: ["tool", "args", "intent"],
      properties: {
        tool: {
          type: "string",
          description: "Executor-side tool name (must be one of the names listed above).",
          enum: executorToolNames,
        },
        args: {
          type: "object",
          description: "Argument object passed verbatim to the executor's tool call.",
        },
        intent: {
          type: "string",
          description: "One-line plain-English description of what this dispatch accomplishes.",
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Sub-session tools — synthetic, intercepted before MCP and routed to the
// SubSessionCoordinator. parentSessionId is auto-injected by the orchestrator,
// so it never appears in any schema.
// ---------------------------------------------------------------------------

function buildSessionToolDescriptors(): ToolDescriptor[] {
  return [
    {
      name: CREATE_SUBSESSION_TOOL,
      description: [
        "Spawn an autonomous SUB-SESSION to pursue an independent sub-goal.",
        "The child runs the orchestrator loop on its own, driving toward the",
        "given intent until the evaluator is satisfied — it does NOT wait for a",
        "user prompt. Use this to delegate a self-contained chunk of work so you",
        "can continue in parallel.",
        "",
        "Returns IMMEDIATELY with a snapshot whose status is usually \"running\".",
        "Poll its progress with get_subsession_status, and end it (cancelling it",
        "if still running) with finalize_subsession. The child shares this",
        "session's workspace sandbox.",
        "",
        "GUARDED: a request whose intent matches an active child reuses that",
        "child instead of duplicating it, and there is a small cap on how many",
        "children may run at once — call list_subsessions first to see what is",
        "already in flight, and finalize_subsession to free a slot.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        required: ["intent"],
        properties: {
          intent: {
            type: "string",
            description:
              "The goal the sub-session must resolve, phrased as you would a user request.",
          },
          context: {
            type: "string",
            description:
              "Optional standing context seeded for the child before the intent (background, constraints).",
          },
        },
      },
    },
    {
      name: SUBSESSION_STATUS_TOOL,
      description: [
        "Get a snapshot of a sub-session you spawned: its status",
        "(running/done/error/archived), and — once finished — its result or",
        "error. If you poll and the status has not changed since your last check,",
        "this call deliberately backs off (waits, with growing delay) before",
        "returning — so do other useful work between checks rather than polling",
        "in a tight loop.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        required: ["subSessionId"],
        properties: {
          subSessionId: {
            type: "string",
            description: "The id returned by create_subsession.",
          },
        },
      },
    },
    {
      name: LIST_SUBSESSIONS_TOOL,
      description: [
        "List the sub-sessions currently active for this session — each with its",
        "id, intent, and status. Use this to see how many you have running and",
        "whether the work you are about to delegate is already in flight, before",
        "calling create_subsession. Takes no arguments.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: FINALIZE_SUBSESSION_TOOL,
      description: [
        "Finalize a sub-session: cancel it if still running, record a final",
        "status, and archive it (dereferencing it from this session). Idempotent.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        required: ["subSessionId"],
        properties: {
          subSessionId: {
            type: "string",
            description: "The id returned by create_subsession.",
          },
          finalStatus: {
            type: "string",
            enum: ["done", "error"],
            description:
              "Optional outcome to record when finalizing a child that has not finished on its own.",
          },
        },
      },
    },
  ];
}

/**
 * Stable identity for a dispatch: its tool name plus a canonical stringify of
 * its args (object keys sorted recursively). Order-independence matters because
 * weak models re-emit args via the prompted-JSON fallback, where key order can
 * drift between otherwise-identical calls — a naive JSON.stringify would miss
 * the duplicate.
 */
function dispatchSignature(ask: ExecutorAsk): string {
  return `${ask.tool}::${stableStringify(ask.args)}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

function parseDispatchAsk(
  rawArgs: Record<string, unknown>,
  executorTools: ToolDescriptor[]
): { ok: true; value: ExecutorAsk } | { ok: false; reason: string } {
  const tool = rawArgs.tool;
  const args = rawArgs.args;
  const intent = rawArgs.intent;

  if (typeof tool !== "string" || tool.length === 0) {
    return { ok: false, reason: "dispatch_executor.tool must be a non-empty string" };
  }
  if (typeof intent !== "string" || intent.length === 0) {
    return { ok: false, reason: "dispatch_executor.intent must be a non-empty string" };
  }
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return { ok: false, reason: "dispatch_executor.args must be an object" };
  }

  const allowed = new Set(executorTools.map((t) => t.name));
  if (!allowed.has(tool)) {
    return {
      ok: false,
      reason: `dispatch_executor.tool "${tool}" is not in the executor's allowed tool set`,
    };
  }

  return {
    ok: true,
    value: {
      tool,
      args: args as Record<string, unknown>,
      intent,
    },
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

function formatFeedbackForOrchestrator(feedback: ExecutorFeedback): string {
  const lines: string[] = [];
  lines.push(`EXECUTOR: ACK ${feedback.ack ?? "(missing — protocol violation)"}`);
  if (feedback.llmReport) {
    lines.push(feedback.llmReport.trim());
  } else {
    lines.push("EXECUTOR: RESULT (no RESULT line emitted by executor)");
  }
  lines.push(
    `EXECUTOR: DETERMINISTIC ${feedback.deterministicVerdict.toUpperCase()} — ${feedback.evidence}`
  );
  lines.push(`EXECUTOR: FINAL ${feedback.ok ? "OK" : "FAIL"}`);
  return lines.join("\n");
}
