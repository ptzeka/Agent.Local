import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { resolve, join, dirname } from 'node:path';

import type { IVectorStore, MetadataFilter, SearchHit, VectorRecord } from './vector-store.js';

export interface FileVectorStoreOptions {
  baseDir?: string;
  // optional layout prefix so consumers stay byte-compatible: 'commits' for code, 'memories' for memory
  partitionDir?: string;
  recordsFile?: string;
}

const DEFAULT_BASE_DIR = 'data';
const DEFAULT_RECORDS_FILE = 'records.jsonl';

// append-only file backend rooted at `data/<partitionDir>/<namespace>/<recordsFile>`
// log-structured: upsert appends a line, reads fold by id (last wins), delete rewrites compacted
export class FileVectorStore implements IVectorStore {
  private readonly baseDir: string;
  private readonly partitionDir: string;
  private readonly recordsFile: string;

  constructor(options: FileVectorStoreOptions = {}) {
    this.baseDir = resolve(options.baseDir ?? DEFAULT_BASE_DIR);
    this.partitionDir = options.partitionDir ?? '';
    this.recordsFile = options.recordsFile ?? DEFAULT_RECORDS_FILE;
  }

  async upsert(records: VectorRecord[]): Promise<void> {
    const byNamespace = new Map<string, VectorRecord[]>();
    for (const r of records) {
      const bucket = byNamespace.get(r.namespace);
      if (bucket) bucket.push(r);
      else byNamespace.set(r.namespace, [r]);
    }
    for (const [namespace, recs] of byNamespace) {
      const path = this.pathFor(namespace);
      mkdirSync(dirname(path), { recursive: true });
      const lines = recs.map(r => JSON.stringify(normalize(r))).join('\n');
      appendFileSync(path, lines + '\n', 'utf-8');
    }
  }

  async get(namespace: string, id: string): Promise<VectorRecord | null> {
    return this.read(namespace).get(id) ?? null;
  }

  async searchByEmbedding(
    namespace: string,
    embedding: number[],
    k: number,
    filter: MetadataFilter = {},
  ): Promise<SearchHit[]> {
    return [...this.read(namespace).values()]
      .filter(r => matchesFilter(r.metadata, filter))
      .map(record => ({ record, score: cosineDistance(embedding, record.embedding) }))
      .sort((a, b) => a.score - b.score)
      .slice(0, k);
  }

  async list(namespace: string, filter: MetadataFilter = {}): Promise<VectorRecord[]> {
    return [...this.read(namespace).values()].filter(r => matchesFilter(r.metadata, filter));
  }

  async delete(namespace: string, ids: string[]): Promise<void> {
    const folded = this.read(namespace);
    let changed = false;
    for (const id of ids) if (folded.delete(id)) changed = true;
    if (changed) this.rewrite(namespace, folded);
  }

  async deleteNamespace(namespace: string): Promise<void> {
    rmSync(dirname(this.pathFor(namespace)), { recursive: true, force: true });
  }

  async listNamespaces(): Promise<string[]> {
    const root = this.partitionRoot();
    if (!existsSync(root)) return [];
    return readdirSync(root, { withFileTypes: true })
      .filter(e => e.isDirectory() && existsSync(join(root, e.name, this.recordsFile)))
      .map(e => decodeURIComponent(e.name))
      .sort((a, b) => a.localeCompare(b));
  }

  async close(): Promise<void> {
    // no pooled resources to release
  }

  private partitionRoot(): string {
    return this.partitionDir.length > 0 ? join(this.baseDir, this.partitionDir) : this.baseDir;
  }

  private pathFor(namespace: string): string {
    return join(this.partitionRoot(), encodeNamespace(namespace), this.recordsFile);
  }

  private read(namespace: string): Map<string, VectorRecord> {
    const path = this.pathFor(namespace);
    const folded = new Map<string, VectorRecord>();
    if (!existsSync(path)) return folded;
    for (const line of readFileSync(path, 'utf-8').split(/\r?\n/)) {
      if (line.trim().length === 0) continue;
      try {
        const record = JSON.parse(line) as VectorRecord;
        folded.set(record.id, record);
      } catch {
        // skip a malformed line rather than fail the whole read
      }
    }
    return folded;
  }

  private rewrite(namespace: string, folded: Map<string, VectorRecord>): void {
    const path = this.pathFor(namespace);
    mkdirSync(dirname(path), { recursive: true });
    const lines = [...folded.values()].map(r => JSON.stringify(r)).join('\n');
    writeFileSync(path, lines.length > 0 ? lines + '\n' : '', 'utf-8');
  }
}

function normalize(record: VectorRecord): VectorRecord {
  return {
    id: record.id,
    namespace: record.namespace,
    content: record.content,
    embedding: record.embedding,
    metadata: record.metadata ?? {},
  };
}

// namespace is opaque, so encode it into one safe path segment; reject dot segments that could traverse
function encodeNamespace(namespace: string): string {
  if (namespace === '.' || namespace === '..') {
    throw new Error(`Invalid namespace: ${namespace}`);
  }
  return encodeURIComponent(namespace);
}

function matchesFilter(metadata: Record<string, unknown>, filter: MetadataFilter): boolean {
  for (const key of Object.keys(filter)) {
    if (JSON.stringify(metadata[key]) !== JSON.stringify(filter[key])) return false;
  }
  return true;
}

function cosineDistance(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na === 0 || nb === 0) return 1;
  return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb));
}
