// File-backed metadata repository, reading the JSON snapshot sidecar codeindex writes.
// Supports flat (<baseDir>/<sha>/) and nested (<baseDir>/commits/<sha>/) layouts sharing one
// schema_versions.json. baseDir is typically {localPath}/.codemcp/data/{owner}/{repo}.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

import type { CommitRow, IMetadataRepository } from './types.js';

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

export class FileMetadataRepository implements IMetadataRepository {
  constructor(private readonly baseDir: string) {}

  async getLatestAppliedMigration(): Promise<string | null> {
    const entries = readSchemaVersions(this.baseDir);
    if (entries.length === 0) return null;
    entries.sort((a, b) => a.scriptName.localeCompare(b.scriptName));
    return entries[entries.length - 1]!.scriptName;
  }

  async listCommits(
    branch: string | null,
    repository: string | null,
    limit: number,
  ): Promise<CommitRow[]> {
    const filtered = readAllCommits(this.baseDir).filter(c => {
      if (branch !== null && c.branch !== branch) return false;
      if (repository !== null && c.repository !== repository) return false;
      return true;
    });
    filtered.sort((a, b) => b.indexedAt.getTime() - a.indexedAt.getTime());
    return filtered.slice(0, limit);
  }

  async close(): Promise<void> {
    // file backend holds no pooled resources
  }
}

// distinct non-empty `repository` values under baseDir; used to auto-register every indexed
// repo when the file backend starts with no --repository flags
export function listIndexedRepositoryIds(baseDir: string): string[] {
  const seen = new Set<string>();
  for (const row of readAllCommits(baseDir)) {
    const id = row.repository?.trim();
    if (id && id.length > 0) seen.add(id);
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

function readSchemaVersions(base: string): SchemaVersionEntry[] {
  const path = resolve(base, 'schema_versions.json');
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf-8');
  if (raw.trim().length === 0) return [];
  return JSON.parse(raw) as SchemaVersionEntry[];
}

// SHA-only directory pattern: exactly 40 hex characters
const SHA_DIR_RE = /^[0-9a-f]{40}$/i;

function commitShaDirsToScan(base: string): string[] {
  const roots: string[] = [base];
  const nested = join(base, 'commits');
  if (existsSync(nested)) roots.push(nested);
  return roots;
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
        // skip malformed commit files rather than fail the whole read
      }
    }
  }
  return out;
}
