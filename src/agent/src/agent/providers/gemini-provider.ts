import { GoogleGenAI } from "@google/genai";
import type { Content, FunctionDeclaration, Part, Tool } from "@google/genai";

import type {
  ChatMessage,
  ChatOptions,
  ChatResponse,
  LLMProvider,
  ToolCall,
  ToolDescriptor,
} from "./provider.js";

export interface GeminiProviderConfig {
  apiKey: string;
  model: string;
  supportsNativeTools: boolean;
  defaultMaxTokens?: number;
}

const DEFAULT_MAX_TOKENS = 8192;
const DEFAULT_TEMPERATURE = 0.2;
const CACHE_TTL = "300s";

export class GeminiProvider implements LLMProvider {
  public readonly providerName = "gemini";
  public readonly modelId: string;
  public readonly supportsNativeTools: boolean;

  private readonly client: GoogleGenAI;
  private readonly defaultMaxTokens: number;

  // Prompt cache for the stable prefix (system instruction + tools).
  // One cache entry per provider instance; invalidated when the key changes.
  private cachedContentName: string | undefined;
  private cacheKey: string | undefined;

  constructor(config: GeminiProviderConfig) {
    this.modelId = config.model;
    this.supportsNativeTools = config.supportsNativeTools;
    this.defaultMaxTokens = config.defaultMaxTokens ?? DEFAULT_MAX_TOKENS;
    this.client = new GoogleGenAI({ apiKey: config.apiKey });
  }

  public async chat(messages: ChatMessage[], options: ChatOptions): Promise<ChatResponse> {
    const { systemInstruction, contents } = toGeminiMessages(messages);
    const tools: Tool[] =
      this.supportsNativeTools && options.tools.length > 0
        ? [{ functionDeclarations: options.tools.map(toGeminiTool) }]
        : [];

    const startedAt = Date.now();

    const cachedContent = await this.ensureCache(systemInstruction, tools);

    // When a cache is active it already contains system + tools, so they must
    // be omitted from the per-request config to avoid an API conflict.
    const config: Record<string, unknown> = {
      temperature: options.temperature ?? DEFAULT_TEMPERATURE,
      maxOutputTokens: options.maxTokens ?? this.defaultMaxTokens,
      abortSignal: options.signal,
    };
    if (cachedContent) {
      config.cachedContent = cachedContent;
    } else {
      if (systemInstruction) config.systemInstruction = systemInstruction;
      if (tools.length > 0) config.tools = tools;
    }

    const response = await this.client.models.generateContent({
      model: this.modelId,
      contents,
      config,
    });

    const totalDurationMs = Date.now() - startedAt;
    const { content, toolCalls } = fromGeminiResponse(response);

    const message: ChatMessage = {
      role: "assistant",
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    };

    return {
      message,
      hasToolCalls: toolCalls.length > 0,
      usage: {
        inputTokens: response.usageMetadata?.promptTokenCount ?? undefined,
        outputTokens: response.usageMetadata?.candidatesTokenCount ?? undefined,
        // Tokens served from the cache (~0.1x input price).
        cacheReadInputTokens: response.usageMetadata?.cachedContentTokenCount ?? undefined,
        totalDurationMs,
      },
    };
  }

  /**
   * Create or reuse a Gemini context cache for the stable system+tools prefix.
   * Cache creation silently fails when the content is below Gemini's minimum
   * token threshold (typically 32 K) or the model doesn't support caching;
   * in those cases we fall through to passing system/tools inline every call.
   */
  private async ensureCache(
    systemInstruction: string | undefined,
    tools: Tool[]
  ): Promise<string | undefined> {
    if (!systemInstruction && tools.length === 0) return undefined;

    const key = JSON.stringify({ systemInstruction, tools });
    if (key === this.cacheKey && this.cachedContentName) {
      return this.cachedContentName;
    }

    try {
      const cacheConfig: Record<string, unknown> = { ttl: CACHE_TTL };
      if (systemInstruction) cacheConfig.systemInstruction = systemInstruction;
      if (tools.length > 0) cacheConfig.tools = tools;

      const cache = await this.client.caches.create({
        model: this.modelId,
        config: cacheConfig,
      });

      this.cachedContentName = cache.name;
      this.cacheKey = key;
      return cache.name;
    } catch {
      // Too few tokens or model doesn't support context caching — inline fallback.
      this.cachedContentName = undefined;
      this.cacheKey = undefined;
      return undefined;
    }
  }
}

/**
 * Split a flat ChatMessage[] into Gemini's (systemInstruction, Content[]) pair.
 *
 * Differences from the Anthropic format:
 *  - System messages become the top-level systemInstruction string.
 *  - Assistant messages use role "model" instead of "assistant".
 *  - Tool calls are functionCall parts inside a model turn.
 *  - Tool results are functionResponse parts inside a user turn, merged with
 *    any immediately preceding user turn to keep role alternation intact.
 */
function toGeminiMessages(messages: ChatMessage[]): {
  systemInstruction: string | undefined;
  contents: Content[];
} {
  const systemParts: string[] = [];
  const contents: Content[] = [];

  for (const message of messages) {
    switch (message.role) {
      case "system": {
        if (message.content.length > 0) systemParts.push(message.content);
        break;
      }

      case "user": {
        const last = contents[contents.length - 1];
        if (last?.role === "user") {
          last.parts = [...(last.parts ?? []), { text: message.content }];
        } else {
          contents.push({ role: "user", parts: [{ text: message.content }] });
        }
        break;
      }

      case "assistant": {
        const parts: Part[] = [];
        if (message.content.trim().length > 0) {
          parts.push({ text: message.content });
        }
        if (message.toolCalls && message.toolCalls.length > 0) {
          for (const call of message.toolCalls) {
            parts.push({
              functionCall: { id: call.id, name: call.name, args: call.arguments },
            });
          }
        }
        if (parts.length === 0) parts.push({ text: "(no content)" });
        contents.push({ role: "model", parts });
        break;
      }

      case "tool": {
        // functionResponse blocks belong in user turns. Merge into the previous
        // user turn when possible (same pattern as Anthropic's tool_result batch).
        const part: Part = {
          functionResponse: {
            id: message.toolCallId,
            name: message.toolName ?? "",
            response: { output: message.content },
          },
        };
        const last = contents[contents.length - 1];
        if (last?.role === "user") {
          last.parts = [...(last.parts ?? []), part];
        } else {
          contents.push({ role: "user", parts: [part] });
        }
        break;
      }
    }
  }

  return {
    systemInstruction: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    contents,
  };
}

function fromGeminiResponse(response: { text?: string; functionCalls?: Array<{ id?: string; name?: string; args?: Record<string, unknown> }> }): {
  content: string;
  toolCalls: ToolCall[];
} {
  const content = response.text ?? "";
  const toolCalls: ToolCall[] = (response.functionCalls ?? []).map((fc) => ({
    // Gemini function call ids are optional; fall back to the name so the
    // toolCallId on the matching tool-result message stays consistent.
    id: fc.id ?? fc.name ?? "unknown",
    name: fc.name ?? "unknown",
    arguments: fc.args ?? {},
  }));
  return { content, toolCalls };
}

function toGeminiTool(descriptor: ToolDescriptor): FunctionDeclaration {
  return {
    name: descriptor.name,
    description: descriptor.description,
    parametersJsonSchema: descriptor.inputSchema,
  };
}
