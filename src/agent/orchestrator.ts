import type { McpToolClient, ToolExecutionResult } from "./mcp-client.js";
import type { ModelRegistry } from "./model-registry.js";
import type {
  ChatMessage,
  ChatResponse,
  LLMProvider,
  ToolCall,
  ToolDescriptor,
} from "./providers/provider.js";
import {
  buildPromptedToolInstructions,
  extractPromptedToolCalls,
} from "./tool-adapter.js";
import {
  EXECUTOR_SYSTEM_PROMPT,
  PLANNER_SYSTEM_PROMPT,
  SOLO_SYSTEM_PROMPT,
} from "./system-prompt.js";
import type { ProjectContext } from "./context-loader.js";

/**
 * Multi-agent orchestrator.
 *
 * The orchestrator is the synchronisation point between the planner and
 * the executor. For each user turn it:
 *
 *   1. (Optionally) runs the PLANNER, a model with no tools whose job is
 *      to produce an ordered plan.
 *   2. Injects that plan as an extra system message visible to the EXECUTOR.
 *   3. Runs the EXECUTOR loop until it stops emitting tool calls or hits
 *      the iteration cap. Each tool call dispatches to the MCP client and
 *      its result is appended as a `role: "tool"` message.
 *   4. Returns the final assistant message to the caller (the REPL).
 *
 * The orchestrator never touches tool internals — it goes through McpToolClient.
 * The orchestrator never imports a concrete provider — it goes through ModelRegistry.
 */

export interface OrchestratorEvent {
  type:
    | "planner-start"
    | "planner-message"
    | "executor-start"
    | "executor-iteration"
    | "executor-message"
    | "tool-call"
    | "tool-result"
    | "final-message"
    | "warning";
  data: Record<string, unknown>;
}

export type OrchestratorListener = (event: OrchestratorEvent) => void;

export interface RunOptions {
  /** When false, skip the planner phase even if config has planFirst: true. */
  usePlanner?: boolean;

  /** Cancel an in-flight run. */
  signal?: AbortSignal;

  /** Subscribe to streaming progress events (planner output, tool calls, etc.). */
  onEvent?: OrchestratorListener;
}

export interface RunResult {
  finalMessage: ChatMessage;
  plan?: string;
  iterations: number;
}

export class Orchestrator {
  private readonly conversation: ChatMessage[] = [];

  constructor(
    private readonly registry: ModelRegistry,
    private readonly tools: McpToolClient,
    private readonly projectContext: ProjectContext | null = null
  ) {}

  /**
   * Reset the conversation history. Called from `/reset` in the REPL.
   */
  public reset(): void {
    this.conversation.length = 0;
  }

  /**
   * Currently-known conversation, useful for the REPL `/history` command.
   */
  public history(): readonly ChatMessage[] {
    return this.conversation;
  }

  /**
   * Run one user turn end-to-end. Returns when the executor produces a
   * final, tool-free response (or the iteration cap is reached).
   */
  public async run(userInput: string, options: RunOptions = {}): Promise<RunResult> {
    const emit = options.onEvent ?? (() => {});
    const usePlanner = options.usePlanner ?? this.registry.orchestration.planFirst;

    // Record the user's message in the shared history immediately.
    this.conversation.push({ role: "user", content: userInput });

    let plan: string | undefined;

    if (usePlanner) {
      plan = await this.runPlanner(userInput, emit, options.signal);
    }

    const result = await this.runExecutor(plan, emit, options.signal);

    emit({
      type: "final-message",
      data: { content: result.finalMessage.content, iterations: result.iterations },
    });

    return { ...result, plan };
  }

  // --------------------------------------------------------------------------
  // Planner phase
  // --------------------------------------------------------------------------

  private async runPlanner(
    userInput: string,
    emit: OrchestratorListener,
    signal: AbortSignal | undefined
  ): Promise<string | undefined> {
    let planner: LLMProvider;
    try {
      planner = this.registry.getProviderForRole("planner");
    } catch {
      // No planner configured. Skip silently and let the executor handle it solo.
      return undefined;
    }

    emit({
      type: "planner-start",
      data: { model: planner.modelId, provider: planner.providerName },
    });

    // The planner sees the same user message but with the planning-specific
    // system prompt. It has no tools and no conversation history beyond this turn.
    // Project context (if any) leads so role-specific direction can override it.
    const plannerMessages: ChatMessage[] = [
      ...this.buildContextMessages(),
      { role: "system", content: PLANNER_SYSTEM_PROMPT },
      { role: "user", content: userInput },
    ];

    const response = await planner.chat(plannerMessages, {
      tools: [],
      temperature: this.registry.orchestration.planTemperature,
      signal,
    });

    const plan = response.message.content.trim();
    if (plan.length === 0) {
      emit({ type: "warning", data: { message: "Planner returned empty content." } });
      return undefined;
    }

    emit({ type: "planner-message", data: { content: plan, usage: response.usage } });
    return plan;
  }

  // --------------------------------------------------------------------------
  // Executor phase
  // --------------------------------------------------------------------------

  private async runExecutor(
    plan: string | undefined,
    emit: OrchestratorListener,
    signal: AbortSignal | undefined
  ): Promise<{ finalMessage: ChatMessage; iterations: number }> {
    const executor = this.registry.getProviderForRole("coder");
    const tools = this.tools.listTools();

    emit({
      type: "executor-start",
      data: {
        model: executor.modelId,
        provider: executor.providerName,
        supportsNativeTools: executor.supportsNativeTools,
        toolCount: tools.length,
      },
    });

    const systemMessages = this.buildExecutorSystemMessages(executor, tools, plan);

    // Working message list: persistent system messages + the conversation so far.
    // We splice the system messages onto the FRONT for every executor call so
    // the conversation history we keep in `this.conversation` stays user/assistant only.
    const workingMessages: ChatMessage[] = [...systemMessages, ...this.conversation];

    const maxIterations = this.registry.orchestration.maxExecutorIterations;

    for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
      emit({ type: "executor-iteration", data: { iteration, max: maxIterations } });

      const response = await executor.chat(workingMessages, {
        tools: executor.supportsNativeTools ? tools : [],
        temperature: this.registry.orchestration.executorTemperature,
        signal,
      });

      const { assistantMessage, toolCalls } = this.normaliseAssistantTurn(executor, response);

      // Always log the assistant's textual content (post-cleaning).
      emit({
        type: "executor-message",
        data: {
          iteration,
          content: assistantMessage.content,
          toolCallCount: toolCalls.length,
          usage: response.usage,
        },
      });

      // Persist assistant turn to conversation history and the local working list.
      this.conversation.push(assistantMessage);
      workingMessages.push(assistantMessage);

      if (toolCalls.length === 0) {
        // No tool calls = final answer.
        return { finalMessage: assistantMessage, iterations: iteration };
      }

      // Dispatch every requested tool call and feed the results back in.
      const toolMessages = await this.dispatchToolCalls(toolCalls, emit);
      this.conversation.push(...toolMessages);
      workingMessages.push(...toolMessages);
    }

    // Hit the iteration cap. Surface a clean message rather than looping forever.
    const truncationNotice: ChatMessage = {
      role: "assistant",
      content:
        `(Reached the executor iteration cap of ${maxIterations} without a final answer. ` +
        "Try a more specific request, or raise AGENT_MAX_ITERATIONS in your .env.)",
    };
    this.conversation.push(truncationNotice);
    emit({
      type: "warning",
      data: { message: "executor hit iteration cap", iterations: maxIterations },
    });
    return { finalMessage: truncationNotice, iterations: maxIterations };
  }

  /**
   * Wrap the loaded project-direction file (if any) as a leading system message.
   * Returned as an array so callers can splat it without conditionals.
   */
  private buildContextMessages(): ChatMessage[] {
    if (!this.projectContext) return [];
    return [
      {
        role: "system",
        content:
          `Project context (from ${this.projectContext.sourcePath}). ` +
          `Treat this as standing direction from the user; follow it unless ` +
          `a specific request overrides it.\n\n` +
          this.projectContext.content,
      },
    ];
  }

  private buildExecutorSystemMessages(
    executor: LLMProvider,
    tools: ToolDescriptor[],
    plan: string | undefined
  ): ChatMessage[] {
    // Project context leads so the role-specific prompt and plan can refine it.
    const messages: ChatMessage[] = [...this.buildContextMessages()];

    // Base prompt: executor flavour if we have a plan, solo flavour if not.
    const basePrompt = plan ? EXECUTOR_SYSTEM_PROMPT : SOLO_SYSTEM_PROMPT;

    // For models without native tool calling, append the prompted-JSON instructions
    // (and tool catalogue) directly to the system prompt so the model knows how to ask.
    const promptedInstructions = executor.supportsNativeTools
      ? ""
      : buildPromptedToolInstructions(tools);

    messages.push({
      role: "system",
      content: basePrompt + promptedInstructions,
    });

    if (plan) {
      messages.push({
        role: "system",
        content: `Plan from planner:\n\n${plan}`,
      });
    }

    return messages;
  }

  private normaliseAssistantTurn(
    executor: LLMProvider,
    response: ChatResponse
  ): { assistantMessage: ChatMessage; toolCalls: ToolCall[] } {
    if (executor.supportsNativeTools) {
      // Native path: the provider already populated message.toolCalls.
      const toolCalls = response.message.toolCalls ?? [];
      return { assistantMessage: response.message, toolCalls };
    }

    // Prompted-JSON path: dig tool calls out of the assistant text and strip
    // the JSON block from the visible content.
    const { toolCalls, cleanedContent } = extractPromptedToolCalls(response.message);
    const assistantMessage: ChatMessage = {
      role: "assistant",
      content: cleanedContent,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    };
    return { assistantMessage, toolCalls };
  }

  private async dispatchToolCalls(
    toolCalls: ToolCall[],
    emit: OrchestratorListener
  ): Promise<ChatMessage[]> {
    const results: ChatMessage[] = [];

    for (const call of toolCalls) {
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

      // Wrap the result text with an error tag if applicable so the model
      // is unambiguous about whether the tool succeeded.
      const wrappedContent = execution.isError
        ? `[tool-error] ${execution.content}`
        : execution.content;

      results.push({
        role: "tool",
        content: wrappedContent,
        toolCallId: call.id,
        toolName: call.name,
      });
    }

    return results;
  }
}
