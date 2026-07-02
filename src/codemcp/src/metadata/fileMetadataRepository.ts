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

// repo-first layout: every repository owns the subtree data/<owner>/<repo>/ marked by its
// schema_versions.json, so the directory path IS the repository id — no commit.json reads.
// Used to auto-register every indexed repo when the file backend starts with no --repository flags
export function listIndexedRepositoryIds(dataRoot: string): string[] {
  const ids: string[] = [];
  collectRepositoryDirs(dataRoot, [], ids, 6);
  return ids.sort((a, b) => a.localeCompare(b));
}

function collectRepositoryDirs(dir: string, segments: string[], ids: string[], depthLeft: number): void {
  if (!existsSync(dir)) return;
  if (segments.length > 0 && existsSync(join(dir, 'schema_versions.json'))) {
    ids.push(segments.join('/'));
    return;
  }
  if (depthLeft === 0) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'commits') continue;
    collectRepositoryDirs(join(dir, entry.name), [...segments, entry.name], ids, depthLeft - 1);
  }
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
