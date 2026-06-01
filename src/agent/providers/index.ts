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

    default:
      throw new Error(
        `Unknown provider "${input.provider}". Add a factory case in src/agent/providers/index.ts.`
      );
  }
}

export type { LLMProvider } from "./provider.js";
export type { ChatMessage, ChatResponse, ChatOptions, ToolCall, ToolDescriptor } from "./provider.js";
