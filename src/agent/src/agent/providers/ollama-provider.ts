import { Ollama, type ChatRequest, type Message as OllamaMessage, type Tool as OllamaTool } from "ollama";

import type {
  ChatMessage,
  ChatOptions,
  ChatResponse,
  LLMProvider,
  ToolCall,
} from "./provider.js";

/**
 * OllamaProvider — talks to a local Ollama daemon over HTTP.
 *
 * One instance binds to one (host, model) pair. The model registry creates
 * a fresh provider per entry in models.json.
 */

export interface OllamaProviderConfig {
  host: string;
  model: string;
  supportsNativeTools: boolean;

  /**
   * If true, strip `<think>...</think>` blocks from the assistant's
   * reply before exposing it to the agent loop. Used for reasoning
   * models like deepseek-r1 whose internal monologue should not leak
   * into the downstream prompt.
   */
  stripThinkBlocks?: boolean;
}

export class OllamaProvider implements LLMProvider {
  public readonly providerName = "ollama";
  public readonly modelId: string;
  public readonly supportsNativeTools: boolean;

  private readonly client: Ollama;
  private readonly stripThinkBlocks: boolean;

  constructor(config: OllamaProviderConfig) {
    this.modelId = config.model;
    this.supportsNativeTools = config.supportsNativeTools;
    this.stripThinkBlocks = config.stripThinkBlocks ?? false;
    this.client = new Ollama({ host: config.host });
  }

  public async chat(messages: ChatMessage[], options: ChatOptions): Promise<ChatResponse> {
    const request: ChatRequest & { stream?: false } = {
      model: this.modelId,
      messages: messages.map(toOllamaMessage),
      stream: false,
      options: {
        temperature: options.temperature ?? 0.2,
        num_predict: options.maxTokens,
      },
    };

    // Only attach tools when the model supports native function calling.
    // For non-tool models we deliberately omit the field so Ollama doesn't
    // refuse the request, and rely on the prompted-JSON adapter higher up.
    if (this.supportsNativeTools && options.tools.length > 0) {
      request.tools = options.tools.map(toOllamaTool);
    }

    const startedAt = Date.now();
    const response = await this.client.chat(request);
    const totalDurationMs = Date.now() - startedAt;

    const rawContent = response.message.content ?? "";
    const cleanedContent = this.stripThinkBlocks ? stripThinkTags(rawContent) : rawContent;

    const toolCalls = extractToolCalls(response.message);

    const message: ChatMessage = {
      role: "assistant",
      content: cleanedContent,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    };

    return {
      message,
      hasToolCalls: toolCalls.length > 0,
      usage: {
        inputTokens: response.prompt_eval_count,
        outputTokens: response.eval_count,
        totalDurationMs,
      },
    };
  }
}

function toOllamaMessage(message: ChatMessage): OllamaMessage {
  // Ollama treats tool responses as `role: "tool"` with the result in `content`.
  // Assistant tool-call requests get serialized into the `tool_calls` field.
  if (message.role === "tool") {
    return {
      role: "tool",
      content: message.content,
    };
  }

  if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
    return {
      role: "assistant",
      content: message.content,
      tool_calls: message.toolCalls.map((call) => ({
        function: {
          name: call.name,
          arguments: call.arguments,
        },
      })),
    };
  }

  return {
    role: message.role,
    content: message.content,
  };
}

function toOllamaTool(descriptor: {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}): OllamaTool {
  return {
    type: "function",
    function: {
      name: descriptor.name,
      description: descriptor.description,
      parameters: descriptor.inputSchema as OllamaTool["function"]["parameters"],
    },
  };
}

function extractToolCalls(message: OllamaMessage): ToolCall[] {
  const rawCalls = (message as OllamaMessage & { tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }> }).tool_calls;
  if (!rawCalls || rawCalls.length === 0) return [];

  return rawCalls.map((raw, index) => ({
    // Ollama does not assign IDs to tool calls; we synthesise stable ones.
    id: `call_${Date.now()}_${index}`,
    name: raw.function.name,
    arguments: raw.function.arguments ?? {},
  }));
}

/**
 * Reasoning models (deepseek-r1, qwq, etc.) wrap their chain-of-thought in
 * `<think>...</think>` blocks. We keep the thinking off the wire to the
 * executor model so the prompt stays focused on the conclusions.
 */
function stripThinkTags(content: string): string {
  return content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}
