// the tool shape the loop advertises to a backend; its canonical home is the mcp package
import type { ToolDescriptor } from "@agent-local/mcp/tooldescriptor";

// the single seam between the agent and any model backend; the loop talks only to this contract
// so adding a backend is a one-file change: implement, register in providers/index.ts, reference from models.json
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;

  // present on assistant messages that requested tool execution
  toolCalls?: ToolCall[];

  // on role:"tool" messages, must match a prior toolCalls[].id
  toolCallId?: string;

  toolName?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;

  // Gemini rejects (HTTP 400) replays of a function call missing its thoughtSignature;
  // captured here so it survives persistence and is echoed back verbatim next turn
  signature?: string;
}

export interface ChatOptions {
  // empty array = no tool use; the provider must honour this, never invent or pre-fill tools
  tools: ToolDescriptor[];

  temperature?: number;
  maxTokens?: number;

  // cancels an in-flight request, e.g. Ctrl+C in the REPL
  signal?: AbortSignal;
}

export interface ChatResponse {
  message: ChatMessage;

  // convenience mirror of message.toolCalls?.length so callers can switch on it cleanly
  hasToolCalls: boolean;

  usage?: {
    // stamped by the orchestrator (the provider has no session handle) so the round stays attributable downstream
    sessionId?: string;
    inputTokens?: number;
    outputTokens?: number;
    // cache reads cost ~0.1x input; tracked to verify cache hits actually land
    cacheReadInputTokens?: number;
    // cache writes cost ~1.25x input
    cacheCreationInputTokens?: number;
    totalDurationMs?: number;
  };
}

export interface LLMProvider {
  // backend name for logs/errors (e.g. "ollama"); not the model — see modelId
  readonly providerName: string;

  // concrete model the provider hits; telemetry only
  readonly modelId: string;

  // false means the agent must fall back to prompted JSON tool calls
  readonly supportsNativeTools: boolean;

  chat(messages: ChatMessage[], options: ChatOptions): Promise<ChatResponse>;
}
