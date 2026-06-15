import { LocalEmbedAdapter } from './local.js';
import { VoyageEmbedAdapter } from './voyage.js';
import { OpenAIEmbedAdapter } from './openai.js';

// the embedding backends this package can build; the canonical home for the union both consumers used to duplicate
export type EmbedProvider = 'local' | 'voyage' | 'openai';

export interface EmbedAdapter {
  // stable identifier stored on the commit row (e.g. "local:hashed-bag-768"); lets a reader refuse cross-model queries
  readonly modelId: string;
  // output dimensionality — must match the vector(N) column
  readonly dim: number;
  embedBatch(texts: string[]): Promise<number[][]>;
  // Voyage tags a query differently from a document, so this can't be derived from embedBatch
  embedQuery(text: string): Promise<number[]>;
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
