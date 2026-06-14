import { AnthropicProvider } from "./anthropic-provider.js";
import { GeminiProvider } from "./gemini-provider.js";
import { OllamaProvider } from "./ollama-provider.js";
import type { LLMProvider } from "./provider.js";

// plug in a new backend by adding a case below; the model registry calls createProvider per models.json entry
export interface ProviderFactoryInput {
  provider: string;
  model: string;
  supportsTools: boolean;
  reasoning?: boolean;
  host: string;
  // undefined for local backends
  apiKey?: string;
  // falls back to apiKey when absent
  geminiApiKey?: string;
}

export function createProvider(input: ProviderFactoryInput): LLMProvider {
  switch (input.provider) {
    case "ollama":
      return new OllamaProvider({
        host: input.host,
        model: input.model,
        supportsNativeTools: input.supportsTools,
        stripThinkBlocks: input.reasoning ?? false,
      });

    case "anthropic": {
      if (!input.apiKey) {
        throw new Error(
          `Model "${input.model}" uses provider "anthropic" but no API key is set. ` +
            "Add ANTHROPIC_API_KEY to your environment (.env)."
        );
      }
      return new AnthropicProvider({
        apiKey: input.apiKey,
        model: input.model,
        supportsNativeTools: input.supportsTools,
      });
    }

    case "gemini": {
      const key = input.geminiApiKey ?? input.apiKey;
      if (!key) {
        throw new Error(
          `Model "${input.model}" uses provider "gemini" but no API key is set. ` +
            "Add GEMINI_API_KEY to your environment (.env)."
        );
      }
      return new GeminiProvider({
        apiKey: key,
        model: input.model,
        supportsNativeTools: input.supportsTools,
      });
    }

    default:
      throw new Error(
        `Unknown provider "${input.provider}". Add a factory case in src/agent/providers/index.ts.`
      );
  }
}

export type { LLMProvider } from "./provider.js";
export type { ChatMessage, ChatResponse, ChatOptions, ToolCall, ToolDescriptor } from "./provider.js";
