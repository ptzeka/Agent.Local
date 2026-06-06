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
import { reloadProjectContext, type ProjectContext } from "./context-loader.js";
import { Summarizer } from "./summarizer.js";
import { Evaluator, type EvaluationVerdict } from "./evaluator.js";

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
 */

const DISPATCH_TOOL_NAME = "dispatch_executor";

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
    | "warning";
  data: Record<string, unknown>;
}

export type OrchestratorListener = (event: OrchestratorEvent) => void;

export interface RunOptions {
  signal?: AbortSignal;
  onEvent?: OrchestratorListener;
}

export interface RunResult {
  finalMessage: ChatMessage;
  iterations: number;
  dispatches: number;
}

export interface ResetResult {
  /** The context now in effect after the reload (null if no file present). */
  context: ProjectContext | null;
  /** True if the reloaded context differs from what was loaded before. */
  contextChanged: boolean;
}

export class Orchestrator {
  private readonly conversation: ChatMessage[] = [];

  // Mutable: a reset re-reads the context file from disk so mid-session
  // edits to agentcontext.md take effect.
  private projectContext: ProjectContext | null;

  constructor(
    private readonly registry: ModelRegistry,
    private readonly tools: McpToolClient,
    projectContext: ProjectContext | null = null,
    private readonly workspaceRoot: string | null = null
  ) {
    this.projectContext = projectContext;
  }

  /**
   * Reset to session start: drop the entire conversation and re-read the
   * project context file from disk. The context read lives in the
   * Repository layer (context-loader) — we only swap the result in here.
   */
  public async reset(): Promise<ResetResult> {
    this.conversation.length = 0;

    if (this.workspaceRoot === null) {
      // No workspace to reload from; just report the unchanged context.
      return { context: this.projectContext, contextChanged: false };
    }

    const previousContent = this.projectContext?.content ?? null;
    const reloaded = await reloadProjectContext(this.workspaceRoot);
    this.projectContext = reloaded;

    return {
      context: reloaded,
      contextChanged: (reloaded?.content ?? null) !== previousContent,
    };
  }

  public history(): readonly ChatMessage[] {
    return this.conversation;
  }

  /**
   * Run one user turn end-to-end. The orchestrator loop:
   *   - asks its LLM for the next move
   *   - dispatches any read-only tool calls directly via MCP
   *   - catches `dispatch_executor` calls and routes them to Executor.run
   *   - feeds structured feedback back to the LLM
   *   - returns when the LLM produces a final tool-free message or caps out
   */
  public async run(userInput: string, options: RunOptions = {}): Promise<RunResult> {
    const emit = options.onEvent ?? (() => {});

    await this.maybeSummarize(emit, options.signal);

    this.conversation.push({ role: "user", content: userInput });

    const orchestratorProvider = this.registry.getProviderForRole("orchestrator");
    const executorProvider = this.registry.getProviderForRole("executor");

    const orchestratorTools = this.tools.listToolsForOrchestrator();
    const executorTools = this.tools.listToolsForExecutor();

    const dispatchDescriptor = buildDispatchToolDescriptor(executorTools);
    const visibleTools: ToolDescriptor[] = [...orchestratorTools, dispatchDescriptor];

    const executor = new Executor(executorProvider, this.tools, executorTools);

    emit({
      type: "orchestrator-start",
      data: {
        orchestratorModel: orchestratorProvider.modelId,
        executorModel: executorProvider.modelId,
        readToolCount: orchestratorTools.length,
        executorToolCount: executorTools.length,
      },
    });

    const systemMessages = this.buildSystemMessages(orchestratorProvider, visibleTools);
    const workingMessages: ChatMessage[] = [...systemMessages, ...this.conversation];

    const maxIterations = this.registry.orchestration.maxOrchestratorIterations;
    const maxDispatches = this.registry.orchestration.maxExecutorDispatchesPerTurn;
    const maxExecutorIterations = this.registry.orchestration.maxExecutorIterationsPerAsk;

    let dispatches = 0;

    for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
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

      this.conversation.push(assistantMessage);
      workingMessages.push(assistantMessage);

      if (toolCalls.length === 0) {
        // Candidate completion. Gate it through the evaluator: the turn only
        // ends on a SATISFIED verdict. CONTINUE and UNSATISFIED both keep the
        // loop running, with different steering.
        const verdict = await this.evaluateCompletion(
          userInput,
          assistantMessage.content,
          workingMessages,
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
        this.conversation.push(nudge);
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
          continue;
        }

        // Read-only MCP tool. Dispatch directly.
        emit({
          type: "tool-call",
          data: { id: call.id, name: call.name, arguments: call.arguments },
        });

        const execution: ToolExecutionResult = await this.tools.callTool(call.name, call.arguments);

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

      this.conversation.push(...toolMessages);
      workingMessages.push(...toolMessages);
    }

    const truncationNotice: ChatMessage = {
      role: "assistant",
      content:
        `ORCHESTRATOR: hit iteration cap of ${maxIterations} without a final answer. ` +
        "Try a narrower request or raise maxOrchestratorIterations in models.json.",
    };
    this.conversation.push(truncationNotice);
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
   * The tail boundary is snapped forward to avoid orphaning a `role:"tool"`
   * message from its parent assistant tool-call turn.
   */
  private async maybeSummarize(
    emit: OrchestratorListener,
    signal?: AbortSignal
  ): Promise<void> {
    const threshold = this.registry.orchestration.summarizeAtMessages;
    if (this.conversation.length <= threshold) return;

    const desiredKeep = this.registry.orchestration.summarizerKeepLastN;
    const tailStart = findCleanTailStart(this.conversation, desiredKeep);
    if (tailStart === 0) return;

    const prefix = this.conversation.slice(0, tailStart);
    const tail = this.conversation.slice(tailStart);

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

    const summaryMessage: ChatMessage = {
      role: "system",
      content:
        `Conversation summary (covers ${prefix.length} earlier message(s), ` +
        `condensed by the summarizer model). Treat this as ground-truth ` +
        `context for everything that happened before the messages below.\n\n` +
        summaryText,
    };

    this.conversation.length = 0;
    this.conversation.push(summaryMessage, ...tail);

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
    visibleTools: ToolDescriptor[]
  ): ChatMessage[] {
    const messages: ChatMessage[] = [];

    if (this.projectContext) {
      messages.push({
        role: "system",
        content:
          `Project context (from ${this.projectContext.sourcePath}). ` +
          `Treat this as standing direction from the user; follow it unless ` +
          `a specific request overrides it.\n\n` +
          this.projectContext.content,
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
