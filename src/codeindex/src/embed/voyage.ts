import type { EmbedAdapter } from './index.js';

const DEFAULT_MODEL = 'voyage-code-3';

interface VoyageResponse {
  data: { embedding: number[] }[];
}

export class VoyageEmbedAdapter implements EmbedAdapter {
  readonly modelId: string;
  readonly dim: number;
  private readonly apiKey: string;
  private readonly modelName: string;

  constructor(dim: number) {
    const apiKey = process.env.VOYAGE_API_KEY ?? '';
    if (apiKey === '') {
      // Don't throw at construction time — the user may only be building.
      // Throw on first call instead.
    }
    this.apiKey = apiKey;
    this.modelName = process.env.VOYAGE_MODEL ?? DEFAULT_MODEL;
    this.dim = dim;
    this.modelId = `voyage:${this.modelName}-${dim}`;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (this.apiKey === '') {
      throw new Error('VOYAGE_API_KEY is not set. Set it to use the voyage embed provider.');
    }
    const res = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.modelName,
        input: texts,
        input_type: 'document',
        output_dimension: this.dim,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Voyage embeddings request failed: ${res.status} ${body}`);
    }
    const json = (await res.json()) as VoyageResponse;
    return json.data.map(d => d.embedding);
  }
}
