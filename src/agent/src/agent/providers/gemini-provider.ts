import { GoogleGenAI } from "@google/genai";
import type {
  Content,
  FunctionDeclaration,
  GenerateContentResponse,
  Part,
  Tool,
} from "@google/genai";

import type { ToolDescriptor } from "@agent-local/mcp/tooldescriptor";
import type {
  ChatMessage,
  ChatOptions,
  ChatResponse,
  LLMProvider,
  ToolCall,
} from "./provider.js";

export interface GeminiProviderConfig {
  apiKey: string;
  model: string;
  supportsNativeTools: boolean;
  defaultMaxTokens?: number;
}

const DEFAULT_MAX_TOKENS = 8192;
const DEFAULT_TEMPERATURE = 0.2;
const CACHE_TTL_SECONDS = 300;
const CACHE_TTL = `${CACHE_TTL_SECONDS}s`;
// margin before server-side expiry so an in-flight request can't reference an entry that lapses mid-call
const CACHE_EXPIRY_MARGIN_MS = 30_000;

export class GeminiProvider implements LLMProvider {
  public readonly providerName = "gemini";
  public readonly modelId: string;
  public readonly supportsNativeTools: boolean;

  private readonly client: GoogleGenAI;
  private readonly defaultMaxTokens: number;

  // one cache entry per instance for the stable system+tools prefix; reusing a lapsed name 400s,
  // so it is invalidated when the key changes or the server-side TTL nears expiry
  private cachedContentName: string | undefined;
  private cacheKey: string | undefined;
  private cacheExpiresAtMs: number | undefined;

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

    // an active cache already holds system+tools, so omit them per-request to avoid an API conflict
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

    let response;
    try {
      response = await this.client.models.generateContent({
        model: this.modelId,
        contents,
        config,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Provider(gemini:${this.modelId}) failed: ${errorMsg}. ` +
        `Check that the API key is valid and the model "${this.modelId}" is available.`
      );
    }

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
        cacheReadInputTokens: response.usageMetadata?.cachedContentTokenCount ?? undefined,
        totalDurationMs,
      },
    };
  }

  // creation silently fails below Gemini's min token threshold or on models without caching;
  // those cases fall through to passing system/tools inline every call
  private async ensureCache(
    systemInstruction: string | undefined,
    tools: Tool[]
  ): Promise<string | undefined> {
    if (!systemInstruction && tools.length === 0) return undefined;

    const key = JSON.stringify({ systemInstruction, tools });
    if (
      key === this.cacheKey &&
      this.cachedContentName &&
      this.cacheExpiresAtMs !== undefined &&
      Date.now() < this.cacheExpiresAtMs - CACHE_EXPIRY_MARGIN_MS
    ) {
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
      this.cacheExpiresAtMs = cacheExpiryMs(cache.expireTime, Date.now());
      return cache.name;
    } catch {
      // too few tokens or no caching support: fall back to inline system/tools
      this.cachedContentName = undefined;
      this.cacheKey = undefined;
      this.cacheExpiresAtMs = undefined;
      return undefined;
    }
  }
}

// prefers the authoritative server expireTime; falls back to now+TTL, which errs early and just recreates sooner
export function cacheExpiryMs(expireTime: string | undefined, nowMs: number): number {
  const parsed = expireTime ? Date.parse(expireTime) : NaN;
  return Number.isFinite(parsed) ? parsed : nowMs + CACHE_TTL_SECONDS * 1000;
}

// splits flat ChatMessage[] into Gemini's (systemInstruction, Content[]); assistant→"model",
// tool results become functionResponse parts merged into a user turn to keep role alternation intact
export function toGeminiMessages(messages: ChatMessage[]): {
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
            const part: Part = {
              functionCall: { id: call.id, name: call.name, args: call.arguments },
            };
            // Gemini 400s on a replayed functionCall missing its original signature, so echo it back
            if (call.signature) part.thoughtSignature = call.signature;
            parts.push(part);
          }
        }
        if (parts.length === 0) parts.push({ text: "(no content)" });
        contents.push({ role: "model", parts });
        break;
      }

      case "tool": {
        // functionResponse parts belong in a user turn; merge into the prior one to keep alternation
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

// walks raw parts instead of the SDK getters because those discard the per-part thoughtSignature
// thinking models need echoed back; `thought` parts are reasoning, not answer text, so they're skipped
export function fromGeminiResponse(response: GenerateContentResponse): {
  content: string;
  toolCalls: ToolCall[];
} {
  const parts: Part[] = response.candidates?.[0]?.content?.parts ?? [];
  const textChunks: string[] = [];
  const toolCalls: ToolCall[] = [];

  for (const part of parts) {
    if (part.functionCall) {
      const fc = part.functionCall;
      toolCalls.push({
        // ids are optional here; fall back to the name so the matching tool-result's id stays consistent
        id: fc.id ?? fc.name ?? "unknown",
        name: fc.name ?? "unknown",
        arguments: fc.args ?? {},
        signature: part.thoughtSignature,
      });
    } else if (typeof part.text === "string" && !part.thought) {
      textChunks.push(part.text);
    }
  }

  return { content: textChunks.join(""), toolCalls };
}

function toGeminiTool(descriptor: ToolDescriptor): FunctionDeclaration {
  return {
    name: descriptor.name,
    description: descriptor.description,
    parametersJsonSchema: descriptor.inputSchema,
  };
}
