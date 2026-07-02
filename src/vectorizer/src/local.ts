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
    // v2: tokenizer splits camelCase/PascalCase/snake_case into subwords (see tokenize below) —
    // bumped so a reader never mixes v1 vectors (fused identifiers) with v2 queries (split identifiers)
    this.modelId = `local:hashed-bag-v2-${dim}`;
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
  const tokens: string[] = [];
  for (const word of text.split(/[^a-zA-Z0-9]+/)) {
    for (const piece of splitIdentifierCase(word)) {
      const t = piece.toLowerCase();
      if (t.length > 1 && t.length < 64) tokens.push(t);
    }
  }
  return tokens;
}

// breaks camelCase/PascalCase runs (and acronym boundaries: XMLParser -> XML, Parser) apart so an
// identifier decomposes into the same subwords a natural-language query would describe it with;
// underscores are already split by the non-word-char split above, covering snake_case too
function splitIdentifierCase(word: string): string[] {
  return word
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(' ')
    .filter(w => w.length > 0);
}

function hashTo(token: string, dim: number, salt: number): number {
  const h = createHash('sha256').update(`${salt}:${token}`).digest();
  const n = (h.readUInt32BE(0) >>> 0) % dim;
  return n;
}
