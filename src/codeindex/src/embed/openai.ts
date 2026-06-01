import type { EmbedAdapter } from './index.js';

const DEFAULT_MODEL = 'text-embedding-3-small';

interface OpenAIResponse {
  data: { embedding: number[] }[];
}

export class OpenAIEmbedAdapter implements EmbedAdapter {
  readonly modelId: string;
  readonly dim: number;
  private readonly apiKey: string;
  private readonly modelName: string;

  constructor(dim: number) {
    this.apiKey = process.env.OPENAI_API_KEY ?? '';
    this.modelName = process.env.OPENAI_EMBED_MODEL ?? DEFAULT_MODEL;
    this.dim = dim;
    this.modelId = `openai:${this.modelName}-${dim}`;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (this.apiKey === '') {
      throw new Error('OPENAI_API_KEY is not set. Set it to use the openai embed provider.');
    }
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.modelName,
        input: texts,
        dimensions: this.dim,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OpenAI embeddings request failed: ${res.status} ${body}`);
    }
    const json = (await res.json()) as OpenAIResponse;
    return json.data.map(d => d.embedding);
  }
}
