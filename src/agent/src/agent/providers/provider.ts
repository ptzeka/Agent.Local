/**
 * LLMProvider — the single seam between the agent and any model backend.
 *
 * Anything we call "an LLM" in this codebase must satisfy this interface.
 * The agent loop never imports a concrete provider; it asks the model
 * registry for a `LLMProvider` and talks to it through this contract.
 *
 * Adding a new backend (LM Studio, vLLM, an OpenAI-compatible endpoint, etc.)
 * is therefore a single-file change: implement this interface, register it
 * in `providers/index.ts`, and reference it from `models.json`.
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;

  /**
   * Present on assistant messages that requested tool execution.
   * The agent loop reads this to know which tools to dispatch next.
   */
  toolCalls?: ToolCall[];

  /**
   * Present on `role: "tool"` messages. Identifies which tool call
   * this message is responding to (must match a prior toolCalls[].id).
   */
  toolCallId?: string;

  /**
   * Optional human-readable label for tool responses.
   */
  toolName?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;

  /**
   * Opaque provider round-trip token. Some thinking models (Gemini) attach a
   * `thoughtSignature` to each function-call part and reject (HTTP 400) any
   * later request that replays the call without it. Capturing it here lets the
   * signature survive session persistence and be echoed back verbatim on the
   * next turn. Undefined for providers that don't use it (Anthropic, Ollama).
   */
  signature?: string;
}

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ChatOptions {
  /**
   * Tools the model is allowed to call this turn. Empty array = no tool use.
   * The provider must honour this — never invent or pre-fill tools.
   */
  tools: ToolDescriptor[];

  /** Sampling temperature. Lower = more deterministic. */
  temperature?: number;

  /** Maximum tokens to generate this turn. Provider may clamp. */
  maxTokens?: number;

  /**
   * AbortSignal callers can use to cancel an in-flight request
   * (e.g. when the user hits Ctrl+C in the REPL).
   */
  signal?: AbortSignal;
}

export interface ChatResponse {
  message: ChatMessage;

  /**
   * True if the provider produced one or more tool calls this turn.
   * Equivalent to `message.toolCalls && message.toolCalls.length > 0`,
   * provided here as a convenience so callers can switch on it cleanly.
   */
  hasToolCalls: boolean;

  /**
   * Optional usage stats for cost/latency visibility. Providers that
   * don't expose this may leave it undefined.
   */
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    /**
     * Tokens served from the prompt cache (~0.1x input price). Present only
     * for providers that support prompt caching; verifies cache hits land.
     */
    cacheReadInputTokens?: number;
    /** Tokens written to the prompt cache this request (~1.25x input price). */
    cacheCreationInputTokens?: number;
    totalDurationMs?: number;
  };
}

export interface LLMProvider {
  /**
   * Stable name used in logs and errors, e.g. "ollama" or "lmstudio".
   * Does NOT identify a specific model — see `modelId` for that.
   */
  readonly providerName: string;

  /**
   * The underlying model identifier the provider will hit
   * (e.g. "qwen2.5-coder:14b" for Ollama). Used for telemetry only.
   */
  readonly modelId: string;

  /**
   * Whether this model can be given an Ollama/OpenAI-style `tools`
   * array and respond with structured tool calls. False means the
   * agent should fall back to prompted JSON tool calls.
   */
  readonly supportsNativeTools: boolean;

  chat(messages: ChatMessage[], options: ChatOptions): Promise<ChatResponse>;
}
