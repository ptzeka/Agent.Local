import { createHash } from 'node:crypto';

export interface EmbedAdapter {
  readonly modelId: string;
  readonly dim: number;
  embedQuery(text: string): Promise<number[]>;
}

export function createQueryEmbedAdapter(provider: 'local' | 'voyage' | 'openai', dim: number): EmbedAdapter {
  switch (provider) {
    case 'local':  return new LocalQueryEmbedAdapter(dim);
    case 'voyage': return new VoyageQueryEmbedAdapter(dim);
    case 'openai': return new OpenAIQueryEmbedAdapter(dim);
    default:
      throw new Error(`Unknown embed provider: ${String(provider)}`);
  }
}

// mirror of the writer-side adapter in codeindex/src/embed/local.ts; both must produce the
// same vector for the same text — change one, change the other
class LocalQueryEmbedAdapter implements EmbedAdapter {
  readonly modelId: string;
  readonly dim: number;
  constructor(dim: number) {
    this.dim = dim;
    this.modelId = `local:hashed-bag-${dim}`;
  }
  async embedQuery(text: string): Promise<number[]> {
    return embedHashed(text, this.dim);
  }
}

class VoyageQueryEmbedAdapter implements EmbedAdapter {
  readonly modelId: string;
  readonly dim: number;
  private readonly apiKey: string;
  private readonly modelName: string;
  constructor(dim: number) {
    this.apiKey = process.env.VOYAGE_API_KEY ?? '';
    this.modelName = process.env.VOYAGE_MODEL ?? 'voyage-code-3';
    this.dim = dim;
    this.modelId = `voyage:${this.modelName}-${dim}`;
  }
  async embedQuery(text: string): Promise<number[]> {
    if (this.apiKey === '') throw new Error('VOYAGE_API_KEY is not set');
    const res = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.modelName,
        input: [text],
        input_type: 'query',
        output_dimension: this.dim,
      }),
    });
    if (!res.ok) throw new Error(`Voyage query failed: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { data: { embedding: number[] }[] };
    const first = json.data[0];
    if (!first) throw new Error('Voyage returned no embedding');
    return first.embedding;
  }
}

class OpenAIQueryEmbedAdapter implements EmbedAdapter {
  readonly modelId: string;
  readonly dim: number;
  private readonly apiKey: string;
  private readonly modelName: string;
  constructor(dim: number) {
    this.apiKey = process.env.OPENAI_API_KEY ?? '';
    this.modelName = process.env.OPENAI_EMBED_MODEL ?? 'text-embedding-3-small';
    this.dim = dim;
    this.modelId = `openai:${this.modelName}-${dim}`;
  }
  async embedQuery(text: string): Promise<number[]> {
    if (this.apiKey === '') throw new Error('OPENAI_API_KEY is not set');
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.modelName, input: text, dimensions: this.dim }),
    });
    if (!res.ok) throw new Error(`OpenAI query failed: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { data: { embedding: number[] }[] };
    const first = json.data[0];
    if (!first) throw new Error('OpenAI returned no embedding');
    return first.embedding;
  }
}

function embedHashed(text: string, dim: number): number[] {
  const tokens = text.toLowerCase().split(/[^a-z0-9_]+/).filter(t => t.length > 1 && t.length < 64);
  const vec = new Array<number>(dim).fill(0);
  for (const tok of tokens) {
    const h1 = hashTo(tok, dim, 0);
    const h2 = hashTo(tok, dim, 1);
    vec[h1] = (vec[h1] ?? 0) + 1;
    vec[h2] = (vec[h2] ?? 0) - 1;
  }
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm === 0) return vec;
  for (let i = 0; i < vec.length; i++) vec[i] = (vec[i] ?? 0) / norm;
  return vec;
}

function hashTo(token: string, dim: number, salt: number): number {
  const h = createHash('sha256').update(`${salt}:${token}`).digest();
  return (h.readUInt32BE(0) >>> 0) % dim;
}
