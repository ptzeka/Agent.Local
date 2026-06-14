import Anthropic from "@anthropic-ai/sdk";

import type {
  ChatMessage,
  ChatOptions,
  ChatResponse,
  LLMProvider,
  ToolCall,
  ToolDescriptor,
} from "./provider.js";

// one instance per (apiKey, model), mirroring OllamaProvider; the real work is translating
// this codebase's flat ChatMessage[] to Anthropic's structured Messages format and back
export interface AnthropicProviderConfig {
  apiKey: string;
  model: string;
  supportsNativeTools: boolean;
  defaultMaxTokens?: number;
}

// safe to set high because chat() streams; the non-streaming create() trips SDK HTTP timeouts past ~16K
const DEFAULT_MAX_TOKENS = 16000;
const DEFAULT_TEMPERATURE = 0.2;

// cache lookup walks back at most 20 blocks; a dispatch-heavy iteration can append more,
// so a second breakpoint ~15 blocks behind the tail guarantees a hit point inside the window
const LOOKBACK_BLOCK_SPAN = 15;

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

    // each call extends the prior prompt, so tail breakpoints let iteration N read N-1 at cache price
    applyMessageBreakpoints(anthropicMessages);

    const request: Anthropic.MessageCreateParamsNonStreaming = {
      model: this.modelId,
      max_tokens: options.maxTokens ?? this.defaultMaxTokens,
      temperature: options.temperature ?? DEFAULT_TEMPERATURE,
      messages: anthropicMessages,
    };

    if (system.length > 0) {
      // breakpoint on the last system block caches the stable tools+system prefix re-sent every iteration
      system[system.length - 1] = {
        ...system[system.length - 1],
        cache_control: { type: "ephemeral" },
      };
      request.system = system;
    }

    // advertise tools only when natively supported and offered, matching OllamaProvider's contract
    if (this.supportsNativeTools && options.tools.length > 0) {
      request.tools = options.tools.map(toAnthropicTool);
    }

    const startedAt = Date.now();
    let response;
    try {
      // stream so high max_tokens can't trip the SDK's non-streaming HTTP timeout
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
        // null→undefined so callers treat "unsupported" and "zero" uniformly via ?? 0
        cacheReadInputTokens: response.usage.cache_read_input_tokens ?? undefined,
        cacheCreationInputTokens: response.usage.cache_creation_input_tokens ?? undefined,
        totalDurationMs,
      },
    };
  }
}

// two moving breakpoints from the tail: one on the last block (next call reads up to here as a hit)
// and one LOOKBACK_BLOCK_SPAN earlier so THIS call still hits when an iteration overran the 20-block window
export function applyMessageBreakpoints(messages: Anthropic.MessageParam[]): void {
  let blocksFromEnd = 0;

  for (let m = messages.length - 1; m >= 0; m -= 1) {
    const message = messages[m];
    const blocks: Anthropic.ContentBlockParam[] =
      typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : message.content;

    for (let b = blocks.length - 1; b >= 0; b -= 1) {
      blocksFromEnd += 1;
      if (blocksFromEnd === 1 || blocksFromEnd === LOOKBACK_BLOCK_SPAN + 1) {
        (blocks[b] as { cache_control?: { type: "ephemeral" } }).cache_control = {
          type: "ephemeral",
        };
        // only block objects can hold cache_control, so persist the string→block normalisation
        message.content = blocks;
        if (blocksFromEnd > 1) return;
      }
    }
  }
}

// splits flat ChatMessage[] into Anthropic's (system, messages); system collapses to one
// text block so chat() can attach a single cache breakpoint, tool results fold into user turns
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
        // merge into the prior user turn when it is already a tool_result batch, keeping pairing intact
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

  // one cacheable unit; empty array means no system prompt and chat() omits the field
  const system: Anthropic.TextBlockParam[] =
    systemParts.length > 0 ? [{ type: "text", text: systemParts.join("\n\n") }] : [];

  return { system, anthropicMessages: repairToolPairing(out) };
}

// stands in for a tool_use whose real result was never recorded (interrupted run)
const MISSING_TOOL_RESULT =
  "[tool result unavailable — the previous run was interrupted before this tool completed]";

// the Messages API rejects a tool_use with no following tool_result; a persisted transcript
// interrupted mid-turn can violate this, so synthesize error-flagged results for unanswered ids
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
      // lead the next user turn with the synthetic results so no two user turns are created
      const nextBlocks: Anthropic.ContentBlockParam[] = Array.isArray(next.content)
        ? next.content
        : [{ type: "text", text: next.content }];
      messages[i + 1] = { role: "user", content: [...synthetic, ...nextBlocks] };
    } else {
      // nothing (or an assistant turn) follows: insert a standalone results turn
      result.push({ role: "user", content: synthetic });
    }
  }

  return result;
}

function blockType(block: Anthropic.ContentBlockParam | string): string | undefined {
  return typeof block === "object" && block !== null
    ? (block as { type?: string }).type
    : undefined;
}

function isToolResultBatch(content: Anthropic.MessageParam["content"]): boolean {
  return (
    Array.isArray(content) &&
    content.length > 0 &&
    content.every((b) => typeof b === "object" && b !== null && (b as { type?: string }).type === "tool_result")
  );
}

// Anthropic rejects empty message content, so substitute a placeholder
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
