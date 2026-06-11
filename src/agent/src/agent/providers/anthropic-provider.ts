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
  /**
   * Per-request output cap when a caller does not specify one. The default is
   * comfortably high because chat() streams the response — see DEFAULT_MAX_TOKENS.
   */
  defaultMaxTokens?: number;
}

// Safe to set high because chat() streams via messages.stream() + finalMessage()
// rather than the non-streaming create(), which would hit SDK HTTP timeouts as
// max_tokens climbs past ~16K. Opus supports up to 128K output over a stream.
const DEFAULT_MAX_TOKENS = 16000;
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
      // Prompt caching: mark the last system block as a cache breakpoint. Render
      // order is tools -> system -> messages, so a breakpoint here caches the
      // whole stable prefix (tool definitions + system) as one ephemeral entry.
      // The orchestrator re-sends this identical prefix every iteration; after
      // the first write it reads back at ~0.1x input cost. 5-minute TTL (the
      // ephemeral default) comfortably outlasts a single chatty turn.
      system[system.length - 1] = {
        ...system[system.length - 1],
        cache_control: { type: "ephemeral" },
      };
      request.system = system;
    }

    // Only advertise tools when the model supports native function calling and
    // the caller actually offered some — matching OllamaProvider's contract.
    if (this.supportsNativeTools && options.tools.length > 0) {
      request.tools = options.tools.map(toAnthropicTool);
    }

    const startedAt = Date.now();
    let response;
    try {
      // Stream the response so high max_tokens values don't trip the SDK's
      // non-streaming HTTP timeout. We still collect the full message before
      // returning — finalMessage() yields the same Anthropic.Message that
      // create() would have, so everything downstream is unchanged.
      const stream = this.client.messages.stream(request, { signal: options.signal });
      response = await stream.finalMessage();
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Provider(anthropic:${this.modelId}) failed: ${errorMsg}. ` +
        `Check that the API key is valid and the model "${this.modelId}" is available.`
      );
    }
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
        // null (no caching this request) is normalised to undefined so callers
        // can treat "unsupported" and "zero" uniformly via ?? 0.
        cacheReadInputTokens: response.usage.cache_read_input_tokens ?? undefined,
        cacheCreationInputTokens: response.usage.cache_creation_input_tokens ?? undefined,
        totalDurationMs,
      },
    };
  }
}

/**
 * Split a flat ChatMessage[] into Anthropic's (system, messages) pair.
 * System messages are concatenated into a single top-level system text block
 * (so chat() can attach one cache breakpoint to it); tool results are folded
 * into user-turn `tool_result` blocks.
 */
function toAnthropicMessages(messages: ChatMessage[]): {
  system: Anthropic.TextBlockParam[];
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

  // Heal any tool_use ⇄ tool_result pairing the source transcript left broken
  // (e.g. a turn interrupted after the assistant's tool_use was recorded but
  // before its results) before handing the array to the API, which rejects an
  // unmatched tool_use outright.
  // System parts collapse into a single text block (one cacheable unit). An
  // empty array means "no system prompt" — chat() omits the field entirely.
  const system: Anthropic.TextBlockParam[] =
    systemParts.length > 0 ? [{ type: "text", text: systemParts.join("\n\n") }] : [];

  return { system, anthropicMessages: repairToolPairing(out) };
}

/** Placeholder result for a tool_use whose real result was never recorded. */
const MISSING_TOOL_RESULT =
  "[tool result unavailable — the previous run was interrupted before this tool completed]";

/**
 * Ensure every assistant `tool_use` block is answered by a `tool_result` in the
 * immediately-following user turn — the invariant the Messages API enforces.
 *
 * A persisted transcript can violate it: if a turn is interrupted (error,
 * abort) after the assistant's tool_use is recorded but before the tool runs,
 * the session is saved ending on a dangling tool_use, and the next user message
 * lands right after it. Rather than reject such a transcript, we synthesize an
 * error-flagged tool_result for each unanswered id and fold it into the
 * following user turn (so no two consecutive user turns are created), or append
 * a fresh user turn when nothing follows.
 */
export function repairToolPairing(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  const result: Anthropic.MessageParam[] = [];

  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    result.push(message);

    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;

    const toolUseIds = message.content
      .filter((block) => blockType(block) === "tool_use")
      .map((block) => (block as Anthropic.ToolUseBlockParam).id);
    if (toolUseIds.length === 0) continue;

    const next = messages[i + 1];
    const providedIds =
      next && next.role === "user" && Array.isArray(next.content)
        ? next.content
            .filter((block) => blockType(block) === "tool_result")
            .map((block) => (block as Anthropic.ToolResultBlockParam).tool_use_id)
        : [];

    const missing = toolUseIds.filter((id) => !providedIds.includes(id));
    if (missing.length === 0) continue;

    const synthetic: Anthropic.ToolResultBlockParam[] = missing.map((id) => ({
      type: "tool_result",
      tool_use_id: id,
      content: MISSING_TOOL_RESULT,
      is_error: true,
    }));

    if (next && next.role === "user") {
      // Lead the next user turn with the synthetic results, keeping it a single
      // user turn. Replace the upcoming element so it is emitted merged.
      const nextBlocks: Anthropic.ContentBlockParam[] = Array.isArray(next.content)
        ? next.content
        : [{ type: "text", text: next.content }];
      messages[i + 1] = { role: "user", content: [...synthetic, ...nextBlocks] };
    } else {
      // Nothing (or an assistant turn) follows: insert a standalone results turn.
      result.push({ role: "user", content: synthetic });
    }
  }

  return result;
}

/** The discriminant `type` of a content block param, or undefined for a string. */
function blockType(block: Anthropic.ContentBlockParam | string): string | undefined {
  return typeof block === "object" && block !== null
    ? (block as { type?: string }).type
    : undefined;
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
