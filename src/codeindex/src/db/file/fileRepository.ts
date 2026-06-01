// File-backed implementation of PgWriterRepository for debugging. Stores
// everything as human-readable JSON / JSONL under `baseDir`:
//
//   <baseDir>/
//     schema_versions.json     [{ scriptName, appliedAt, checksum }]
//     commits/
//       <commitSha>/
//         commit.json          { commitSha, branch, repository, indexedAt, embedModel, ... }
//         chunks.jsonl         one ChunkRow per line
//
// All operations are direct file I/O — no batching, no transactions. The
// connection arg is only used to recover the baseDir.

import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
  readdirSync,
  appendFileSync,
} from 'node:fs';
import { resolve, join } from 'node:path';

import type { DbConnection } from '../types.js';
import type { AppliedMigration, PgWriterRepository } from '../pgRepository.js';
import type { ChunkRow, CommitRow } from '../../types.js';
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

export class FileWriterRepositoryImpl implements PgWriterRepository {
  async ensureSchemaVersionsTable(conn: DbConnection): Promise<void> {
    const base = baseOf(conn);
    const path = schemaVersionsPath(base);
    if (!existsSync(path)) {
      writeFileSync(path, '[]\n', 'utf-8');
    }
    ensureCommitsDir(base);
  }

  async getAppliedMigrations(conn: DbConnection): Promise<AppliedMigration[]> {
    const base = baseOf(conn);
    return readSchemaVersions(base).map(e => ({ scriptName: e.scriptName, checksum: e.checksum }));
  }

  async recordMigration(conn: DbConnection, scriptName: string, checksum: string): Promise<void> {
    const base = baseOf(conn);
    const entries = readSchemaVersions(base);
    if (entries.some(e => e.scriptName === scriptName)) return;
    entries.push({ scriptName, appliedAt: new Date().toISOString(), checksum });
    writeFileSync(schemaVersionsPath(base), JSON.stringify(entries, null, 2) + '\n', 'utf-8');
  }

  async acquireAdvisoryLock(_conn: DbConnection, _key: number): Promise<void> {
    // No-op — the file backend is single-process by design.
  }

  async releaseAdvisoryLock(_conn: DbConnection, _key: number): Promise<void> {
    // No-op.
  }

  async upsertCommit(conn: DbConnection, commit: CommitRow): Promise<void> {
    const base = baseOf(conn);
    const dir = commitDir(base, commit.commitSha);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const data: CommitJson = {
      commitSha: commit.commitSha,
      branch: commit.branch,
      repository: commit.repository,
      indexedAt: new Date().toISOString(),
      embedModel: commit.embedModel,
      embedDim: commit.embedDim,
      fileCount: commit.fileCount,
      chunkCount: commit.chunkCount,
    };
    writeFileSync(commitJsonPath(base, commit.commitSha), JSON.stringify(data, null, 2) + '\n', 'utf-8');
  }

  async deleteChunksForCommit(conn: DbConnection, commitSha: string): Promise<void> {
    const base = baseOf(conn);
    const path = chunksJsonlPath(base, commitSha);
    if (existsSync(path)) rmSync(path);
  }

  async insertChunks(conn: DbConnection, commitSha: string, chunks: ChunkRow[]): Promise<void> {
    const base = baseOf(conn);
    const dir = commitDir(base, commitSha);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const path = chunksJsonlPath(base, commitSha);
    // Write in chunks so we don't materialize a giant single string.
    const lines = chunks.map(c => JSON.stringify(c)).join('\n');
    if (lines.length > 0) {
      // Append a trailing newline so concat to existing file stays line-aligned.
      appendFileSync(path, lines + '\n', 'utf-8');
    }
  }

  async getEmbeddingDimension(_conn: DbConnection): Promise<number | null> {
    // No fixed schema in the file backend — accept any dim. publish() will
    // skip the dim-equality check when this returns null.
    return null;
  }
}

function baseOf(conn: DbConnection): string {
  if (!(conn instanceof FileConnection)) {
    throw new Error('FileWriterRepository requires a FileConnection');
  }
  conn.ensureAlive();
  return conn.baseDir;
}

function schemaVersionsPath(base: string): string {
  return resolve(base, 'schema_versions.json');
}

function ensureCommitsDir(base: string): void {
  const dir = resolve(base, 'commits');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function commitDir(base: string, sha: string): string {
  return resolve(base, 'commits', sanitizeSha(sha));
}

function commitJsonPath(base: string, sha: string): string {
  return join(commitDir(base, sha), 'commit.json');
}

function chunksJsonlPath(base: string, sha: string): string {
  return join(commitDir(base, sha), 'chunks.jsonl');
}

function sanitizeSha(sha: string): string {
  // Allow alnum + dash + underscore. Anything else would be a path-traversal risk.
  if (!/^[A-Za-z0-9_\-]+$/.test(sha)) {
    throw new Error(`Invalid commit identifier: ${sha}`);
  }
  return sha;
}

function readSchemaVersions(base: string): SchemaVersionEntry[] {
  const path = schemaVersionsPath(base);
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf-8');
  if (raw.trim().length === 0) return [];
  return JSON.parse(raw) as SchemaVersionEntry[];
}

export function listCommitShas(base: string): string[] {
  const dir = resolve(base, 'commits');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name);
}
