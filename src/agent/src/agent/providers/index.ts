import { AnthropicProvider } from "./anthropic-provider.js";
import { OllamaProvider } from "./ollama-provider.js";
import type { LLMProvider } from "./provider.js";

/**
 * Provider factory registry.
 *
 * To plug in a new backend, add a case here and ship the implementation
 * file alongside ollama-provider.ts. The model registry calls
 * `createProvider` to materialise providers from models.json entries.
 */

export interface ProviderFactoryInput {
  provider: string;
  model: string;
  supportsTools: boolean;
  reasoning?: boolean;
  host: string;
  /** API key for cloud providers (e.g. Anthropic). Undefined for local backends. */
  apiKey?: string;
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

    default:
      throw new Error(
        `Unknown provider "${input.provider}". Add a factory case in src/agent/providers/index.ts.`
      );
  }
}

export type { LLMProvider } from "./provider.js";
export type { ChatMessage, ChatResponse, ChatOptions, ToolCall, ToolDescriptor } from "./provider.js";
