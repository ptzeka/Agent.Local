import { createHash } from 'node:crypto';
import type { EmbedAdapter } from './embed-adapter.js';

// local, dependency-free embedding: deterministic hashed bag-of-tokens, so the project runs offline.
// Placeholder-grade — reproducible and dimensionally correct but weaker than a real model; swap to
// voyage/openai when accuracy matters. modelId changes with provider so a reader can refuse cross-model queries.
export class LocalEmbedAdapter implements EmbedAdapter {
  readonly modelId: string;
  readonly dim: number;

  constructor(dim: number) {
    this.dim = dim;
    this.modelId = `local:hashed-bag-${dim}`;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map(t => embedOne(t, this.dim));
  }

  // identical hashing to embedBatch: a query and a document of the same text must land on the same vector
  async embedQuery(text: string): Promise<number[]> {
    return embedOne(text, this.dim);
  }
}

function embedOne(text: string, dim: number): number[] {
  const tokens = tokenize(text);
  const vec = new Array<number>(dim).fill(0);
  for (const tok of tokens) {
    const h1 = hashTo(tok, dim, 0);
    const h2 = hashTo(tok, dim, 1);
    vec[h1] = (vec[h1] ?? 0) + 1;
    vec[h2] = (vec[h2] ?? 0) - 1;
  }
  // L2 normalize for cosine-distance friendliness
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm === 0) return vec;
  for (let i = 0; i < vec.length; i++) vec[i] = (vec[i] ?? 0) / norm;
  return vec;
}

function tokenize(text: string): string[] {
  // split on non-word chars, lowercase, drop empties, cap length
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter(t => t.length > 1 && t.length < 64);
}

function hashTo(token: string, dim: number, salt: number): number {
  const h = createHash('sha256').update(`${salt}:${token}`).digest();
  const n = (h.readUInt32BE(0) >>> 0) % dim;
  return n;
}
