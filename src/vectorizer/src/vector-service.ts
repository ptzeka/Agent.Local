import { type EmbedAdapter, type EmbedProvider, createEmbedAdapter } from './embed-adapter.js';

// the vectorizing contract consumers depend on, so a version (local compute, remote, cached) can be swapped behind it
export interface IVectorService {
  readonly modelId: string;
  readonly dim: number;
  embedBatch(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
}

// shared plumbing for every version: identity fields + the empty-input shortcut that no backend should pay for
// versions implement only the two backend calls; cross-cutting behavior is added here once, not per version
export abstract class VectorServiceBase implements IVectorService {
  constructor(
    public readonly modelId: string,
    public readonly dim: number,
  ) {}

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    return this.embedDocuments(texts);
  }

  embedQuery(text: string): Promise<number[]> {
    return this.embedSingle(text);
  }

  protected abstract embedDocuments(texts: string[]): Promise<number[][]>;
  protected abstract embedSingle(text: string): Promise<number[]>;
}

// default version: forwards to a pure-compute EmbedAdapter (local/voyage/openai)
export class VectorService extends VectorServiceBase {
  private readonly adapter: EmbedAdapter;

  constructor(adapter: EmbedAdapter) {
    super(adapter.modelId, adapter.dim);
    this.adapter = adapter;
  }

  static fromProvider(provider: EmbedProvider, dim: number): VectorService {
    return new VectorService(createEmbedAdapter(provider, dim));
  }

  protected embedDocuments(texts: string[]): Promise<number[][]> {
    return this.adapter.embedBatch(texts);
  }

  protected embedSingle(text: string): Promise<number[]> {
    return this.adapter.embedQuery(text);
  }
}
