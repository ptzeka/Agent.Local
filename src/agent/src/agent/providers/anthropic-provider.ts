import Anthropic from "@anthropic-ai/sdk";

import type {
  ChatMessage,
  ChatOptions,
  ChatResponse,
  LLMProvider,
  ToolCall,
  ToolDescriptor,
} from "./provider.js";

/**
 * AnthropicProvider — talks to Anthropic's Messages API (Claude models).
 *
 * One instance binds to one (apiKey, model) pair, mirroring OllamaProvider.
 * The only real work beyond the HTTP call is translating between this
 * codebase's flat `ChatMessage[]` shape and Anthropic's structured Messages
 * format, which differs in three ways:
 *   - `system` messages are not part of the message array; they are lifted
 *     into the top-level `system` parameter.
 *   - assistant tool calls are `tool_use` content blocks (id/name/input).
 *   - `role:"tool"` results are `tool_result` blocks that must live inside a
 *     `user` message and carry the originating `tool_use` id. Consecutive
 *     tool results are merged into one user turn so the tool_use ⇄ tool_result
 *     pairing the API requires stays intact.
 */

export interface AnthropicProviderConfig {
  apiKey: string;
  model: string;
  supportsNativeTools: boolean;
  /** Per-request output cap when a caller does not specify one. */
  defaultMaxTokens?: number;
}

const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_TEMPERATURE = 0.2;

export class AnthropicProvider implements LLMProvider {
  public readonly providerName = "anthropic";
  public readonly modelId: string;
  public readonly supportsNativeTools: boolean;

  private readonly client: Anthropic;
  private readonly defaultMaxTokens: number;

  constructor(config: AnthropicProviderConfig) {
    this.modelId = config.model;
    this.supportsNativeTools = config.supportsNativeTools;
    this.defaultMaxTokens = config.defaultMaxTokens ?? DEFAULT_MAX_TOKENS;
    this.client = new Anthropic({ apiKey: config.apiKey });
  }

  public async chat(messages: ChatMessage[], options: ChatOptions): Promise<ChatResponse> {
    const { system, anthropicMessages } = toAnthropicMessages(messages);

    const request: Anthropic.MessageCreateParamsNonStreaming = {
      model: this.modelId,
      max_tokens: options.maxTokens ?? this.defaultMaxTokens,
      temperature: options.temperature ?? DEFAULT_TEMPERATURE,
      messages: anthropicMessages,
    };

    if (system.length > 0) {
      request.system = system;
    }

    // Only advertise tools when the model supports native function calling and
    // the caller actually offered some — matching OllamaProvider's contract.
    if (this.supportsNativeTools && options.tools.length > 0) {
      request.tools = options.tools.map(toAnthropicTool);
    }

    const startedAt = Date.now();
    const response = await this.client.messages.create(request, { signal: options.signal });
    const totalDurationMs = Date.now() - startedAt;

    const { content, toolCalls } = fromAnthropicContent(response.content);

    const message: ChatMessage = {
      role: "assistant",
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    };

    return {
      message,
      hasToolCalls: toolCalls.length > 0,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        totalDurationMs,
      },
    };
  }
}

/**
 * Split a flat ChatMessage[] into Anthropic's (system, messages) pair.
 * System messages are concatenated into the top-level system string; tool
 * results are folded into user-turn `tool_result` blocks.
 */
function toAnthropicMessages(messages: ChatMessage[]): {
  system: string;
  anthropicMessages: Anthropic.MessageParam[];
} {
  const systemParts: string[] = [];
  const out: Anthropic.MessageParam[] = [];

  for (const message of messages) {
    switch (message.role) {
      case "system": {
        if (message.content.length > 0) systemParts.push(message.content);
        break;
      }

      case "tool": {
        const block: Anthropic.ToolResultBlockParam = {
          type: "tool_result",
          tool_use_id: message.toolCallId ?? "",
          content: message.content,
        };
        // Merge into the previous user turn if it is already a tool_result
        // batch; otherwise open a new user turn for it.
        const last = out[out.length - 1];
        if (last && last.role === "user" && isToolResultBatch(last.content)) {
          (last.content as Anthropic.ContentBlockParam[]).push(block);
        } else {
          out.push({ role: "user", content: [block] });
        }
        break;
      }

      case "assistant": {
        if (message.toolCalls && message.toolCalls.length > 0) {
          const blocks: Anthropic.ContentBlockParam[] = [];
          if (message.content.trim().length > 0) {
            blocks.push({ type: "text", text: message.content });
          }
          for (const call of message.toolCalls) {
            blocks.push({
              type: "tool_use",
              id: call.id,
              name: call.name,
              input: call.arguments,
            });
          }
          out.push({ role: "assistant", content: blocks });
        } else {
          out.push({ role: "assistant", content: nonEmpty(message.content) });
        }
        break;
      }

      case "user": {
        out.push({ role: "user", content: nonEmpty(message.content) });
        break;
      }
    }
  }

  return { system: systemParts.join("\n\n"), anthropicMessages: out };
}

/** True when every block in a user turn is a tool_result (a result batch). */
function isToolResultBatch(content: Anthropic.MessageParam["content"]): boolean {
  return (
    Array.isArray(content) &&
    content.length > 0 &&
    content.every((b) => typeof b === "object" && b !== null && (b as { type?: string }).type === "tool_result")
  );
}

/** Anthropic rejects empty message content; substitute a placeholder. */
function nonEmpty(text: string): string {
  return text.length > 0 ? text : "(no content)";
}

function fromAnthropicContent(content: Anthropic.ContentBlock[]): {
  content: string;
  toolCalls: ToolCall[];
} {
  const texts: string[] = [];
  const toolCalls: ToolCall[] = [];

  for (const block of content) {
    if (block.type === "text") {
      texts.push(block.text);
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        name: block.name,
        arguments: (block.input ?? {}) as Record<string, unknown>,
      });
    }
  }

  return { content: texts.join("\n"), toolCalls };
}

function toAnthropicTool(descriptor: ToolDescriptor): Anthropic.Tool {
  return {
    name: descriptor.name,
    description: descriptor.description,
    input_schema: descriptor.inputSchema as Anthropic.Tool.InputSchema,
  };
}
