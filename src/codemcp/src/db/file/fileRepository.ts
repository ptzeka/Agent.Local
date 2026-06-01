// File-backed implementation of PgReaderRepository for debugging. Reads the
// JSON / JSONL layout written by tools/codeindex's FileWriterRepositoryImpl.
//
// Supported layouts (same schema_versions.json at base):
//
//   (A) Flat — legacy / hand-copied:
//       <baseDir>/<commitSha>/commit.json, chunks.jsonl
//
//   (B) Nested `commits/` — tools/codeindex file backend output:
//       <baseDir>/commits/<commitSha>/commit.json, chunks.jsonl
//
// baseDir is typically: {localPath}/.codemcp/data/{repoOwner}/{repoName}
// (computed by config.repoFileDir() from a RepositoryEntry)

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

import type { DbConnection } from '../types.js';
import type { ChunkRow, CommitRow, PgReaderRepository, SearchFilters } from '../pgRepository.js';
import { FileConnection } from './fileConnectionFactory.js';

interface SchemaVersionEntry {
  scriptName: string;
  appliedAt: string;
  checksum: string;
}

interface CommitJson {
  commitSha: string;
  branch: string;
  repository: string;
  indexedAt: string;
  embedModel: string;
  embedDim: number;
  fileCount: number;
  chunkCount: number;
}

interface StoredChunk {
  path: string;
  area: string;
  language: string;
  kind: string;
  symbol: string | null;
  parentSymbol: string | null;
  startLine: number;
  endLine: number;
  content: string;
  contentHash: string;
  imports: string[];
  claudeMd: string[];
  embedding: number[];
}

export class FileReaderRepositoryImpl implements PgReaderRepository {
  async getLatestAppliedMigration(conn: DbConnection): Promise<string | null> {
    const base = baseOf(conn);
    const entries = readSchemaVersions(base);
    if (entries.length === 0) return null;
    entries.sort((a, b) => a.scriptName.localeCompare(b.scriptName));
    return entries[entries.length - 1]!.scriptName;
  }

  async latestCommitFor(
    conn: DbConnection,
    branch: string,
    repository: string | null,
  ): Promise<CommitRow | null> {
    const base = baseOf(conn);
    const commits = readAllCommits(base).filter(c => {
      if (c.branch !== branch) return false;
      if (repository !== null && c.repository !== repository) return false;
      return true;
    });
    commits.sort((a, b) => b.indexedAt.getTime() - a.indexedAt.getTime());
    return commits[0] ?? null;
  }

  async listCommits(
    conn: DbConnection,
    branch: string | null,
    repository: string | null,
    limit: number,
  ): Promise<CommitRow[]> {
    const base = baseOf(conn);
    const filtered = readAllCommits(base).filter(c => {
      if (branch !== null && c.branch !== branch) return false;
      if (repository !== null && c.repository !== repository) return false;
      return true;
    });
    filtered.sort((a, b) => b.indexedAt.getTime() - a.indexedAt.getTime());
    return filtered.slice(0, limit);
  }

  async searchByEmbedding(
    conn: DbConnection,
    commitSha: string,
    embedding: number[],
    k: number,
    filters: SearchFilters,
  ): Promise<ChunkRow[]> {
    const base = baseOf(conn);
    const chunks = readChunksJsonl(base, commitSha);
    const filtered = chunks.filter(c => matchesFilters(c, filters));
    const scored = filtered.map(c => ({
      chunk: c,
      score: cosineDistance(embedding, c.embedding),
    }));
    scored.sort((a, b) => a.score - b.score);
    return scored.slice(0, k).map(s => toChunkRow(s.chunk, commitSha, s.score));
  }

  async findSymbol(conn: DbConnection, commitSha: string, name: string): Promise<ChunkRow[]> {
    const base = baseOf(conn);
    const chunks = readChunksJsonl(base, commitSha);
    return chunks
      .filter(c => c.symbol === name)
      .sort((a, b) => a.path.localeCompare(b.path) || a.startLine - b.startLine)
      .map(c => toChunkRow(c, commitSha));
  }

  async getFileChunks(conn: DbConnection, commitSha: string, path: string): Promise<ChunkRow[]> {
    const base = baseOf(conn);
    const chunks = readChunksJsonl(base, commitSha);
    return chunks
      .filter(c => c.path === path)
      .sort((a, b) => a.startLine - b.startLine)
      .map(c => toChunkRow(c, commitSha));
  }
}

function baseOf(conn: DbConnection): string {
  if (!(conn instanceof FileConnection)) {
    throw new Error('FileReaderRepository requires a FileConnection');
  }
  conn.ensureAlive();
  return conn.baseDir;
}

function readSchemaVersions(base: string): SchemaVersionEntry[] {
  const path = resolve(base, 'schema_versions.json');
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf-8');
  if (raw.trim().length === 0) return [];
  return JSON.parse(raw) as SchemaVersionEntry[];
}

/** SHA-only directory pattern: exactly 40 hex characters. */
const SHA_DIR_RE = /^[0-9a-f]{40}$/i;

function commitShaDirsToScan(base: string): string[] {
  const roots: string[] = [base];
  const nested = join(base, 'commits');
  if (existsSync(nested)) roots.push(nested);
  return roots;
}

/**
 * Lists distinct non-empty `repository` values found under `baseDir` (flat or
 * nested `commits/` layout). Used when the file backend starts with no
 * `--repository` flags to auto-register every indexed logical repository.
 */
export function listIndexedRepositoryIds(baseDir: string): string[] {
  const seen = new Set<string>();
  for (const row of readAllCommits(baseDir)) {
    const id = row.repository?.trim();
    if (id && id.length > 0) seen.add(id);
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

function readAllCommits(base: string): CommitRow[] {
  if (!existsSync(base)) return [];
  const out: CommitRow[] = [];
  const seen = new Set<string>();
  for (const root of commitShaDirsToScan(base)) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!SHA_DIR_RE.test(entry.name)) continue;
      if (seen.has(entry.name)) continue;
      const commitPath = join(root, entry.name, 'commit.json');
      if (!existsSync(commitPath)) continue;
      try {
        const stored = JSON.parse(readFileSync(commitPath, 'utf-8')) as CommitJson;
        seen.add(entry.name);
        out.push({
          commitSha: stored.commitSha,
          branch: stored.branch,
          repository: stored.repository ?? '',
          indexedAt: new Date(stored.indexedAt),
          embedModel: stored.embedModel,
          embedDim: stored.embedDim,
          fileCount: stored.fileCount,
          chunkCount: stored.chunkCount,
        });
      } catch {
        // Skip malformed commit files rather than blow up search.
      }
    }
  }
  return out;
}

function chunksJsonlPathForCommit(base: string, commitSha: string): string | null {
  if (!SHA_DIR_RE.test(commitSha)) return null;
  const flat = resolve(base, commitSha, 'chunks.jsonl');
  if (existsSync(flat)) return flat;
  const nested = resolve(base, 'commits', commitSha, 'chunks.jsonl');
  if (existsSync(nested)) return nested;
  return null;
}

function readChunksJsonl(base: string, commitSha: string): StoredChunk[] {
  const path = chunksJsonlPathForCommit(base, commitSha);
  if (path === null) return [];
  try { statSync(path); } catch { return []; }
  const raw = readFileSync(path, 'utf-8');
  const out: StoredChunk[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    try {
      out.push(JSON.parse(line) as StoredChunk);
    } catch {
      // Skip malformed lines.
    }
  }
  return out;
}

function matchesFilters(chunk: StoredChunk, filters: SearchFilters): boolean {
  if (filters.area && chunk.area !== filters.area) return false;
  if (filters.kind && chunk.kind !== filters.kind) return false;
  if (filters.language && chunk.language !== filters.language) return false;
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

function toChunkRow(chunk: StoredChunk, commitSha: string, score?: number): ChunkRow {
  const row: ChunkRow = {
    commitSha,
    path: chunk.path,
    area: chunk.area,
    language: chunk.language,
    kind: chunk.kind,
    symbol: chunk.symbol,
    parentSymbol: chunk.parentSymbol,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    content: chunk.content,
    contentHash: chunk.contentHash,
    imports: chunk.imports,
    claudeMd: chunk.claudeMd,
  };
  if (score !== undefined) row.score = score;
  return row;
}
