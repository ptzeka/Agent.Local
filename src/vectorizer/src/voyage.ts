import type { EmbedAdapter } from './embed-adapter.js';

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
    // resolve the key but defer the missing-key error to first call, so a build-only run never throws
    this.apiKey = process.env.VOYAGE_API_KEY ?? '';
    this.modelName = process.env.VOYAGE_MODEL ?? DEFAULT_MODEL;
    this.dim = dim;
    this.modelId = `voyage:${this.modelName}-${dim}`;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return this.request(texts, 'document');
  }

  async embedQuery(text: string): Promise<number[]> {
    const [vec] = await this.request([text], 'query');
    if (!vec) throw new Error('Voyage returned no embedding');
    return vec;
  }

  // input_type distinguishes index-time documents from search queries; Voyage embeds the two differently
  private async request(texts: string[], inputType: 'document' | 'query'): Promise<number[][]> {
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
        input_type: inputType,
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
