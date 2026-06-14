import type { EmbedProvider } from '../config.js';
import { LocalEmbedAdapter } from './local.js';
import { VoyageEmbedAdapter } from './voyage.js';
import { OpenAIEmbedAdapter } from './openai.js';

export interface EmbedAdapter {
  // stable identifier stored on the commit row (e.g. "local:hash-768")
  readonly modelId: string;
  // output dimensionality — must match the vector(N) column
  readonly dim: number;
  embedBatch(texts: string[]): Promise<number[][]>;
}

export function createEmbedAdapter(provider: EmbedProvider, dim: number): EmbedAdapter {
  switch (provider) {
    case 'local':  return new LocalEmbedAdapter(dim);
    case 'voyage': return new VoyageEmbedAdapter(dim);
    case 'openai': return new OpenAIEmbedAdapter(dim);
    default:
      throw new Error(`Unknown embed provider: ${String(provider)}`);
  }
}
