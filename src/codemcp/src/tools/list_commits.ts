import { z } from 'zod';
import type { DbConnectionFactory } from '../db/types.js';
import type { PgReaderRepository, CommitRow } from '../db/pgRepository.js';
import type { ToolDeps } from './registry.js';

export const listCommitsSchema = z.object({
  branch: z.string().optional().describe('Restrict to a single branch.'),
  repository: z.string().optional().describe(
    'Restrict to one registered repository name (`--repository name:path` name). Omit to aggregate all registered repos (file multi-repo).',
  ),
  limit: z.number().int().min(1).max(100).optional().default(10),
});

export type ListCommitsInput = z.infer<typeof listCommitsSchema>;

async function fetchCommits(
  factory: DbConnectionFactory,
  repo: PgReaderRepository,
  branch: string | null,
  repositoryFilter: string | null,
  limit: number,
): Promise<CommitRow[]> {
  await using conn = await factory.getConnection();
  return repo.listCommits(conn, branch, repositoryFilter, limit);
}

export async function listCommits(input: ListCommitsInput, deps: ToolDeps): Promise<string> {
  const { factory, repo, currentRepository, repoReaders } = deps;
  const repositoryFilter = input.repository?.trim().length ? input.repository.trim() : null;
  const branchFilter = input.branch ?? null;

  let rows: CommitRow[];

  if (repoReaders.size > 0) {
    // Multi-repo file backend: aggregate from each registered repository,
    // optionally filtered by the requested repository name.
    const readers = repositoryFilter !== null
      ? (repoReaders.has(repositoryFilter) ? [[repositoryFilter, repoReaders.get(repositoryFilter)!] as const] : [])
      : [...repoReaders.entries()];

    const allRows: CommitRow[] = [];
    for (const [repoName, reader] of readers) {
      const filterForReader = repositoryFilter ?? repoName;
      const partial = await fetchCommits(reader.factory, reader.repo, branchFilter, filterForReader, input.limit);
      allRows.push(...partial);
    }
    allRows.sort((a, b) => b.indexedAt.getTime() - a.indexedAt.getTime());
    rows = allRows.slice(0, input.limit);
  } else {
    // Single backend (Postgres or single-repo file): use the primary reader.
    await using conn = await factory.getConnection();
    rows = await repo.listCommits(conn, branchFilter, repositoryFilter, input.limit);
  }

  if (rows.length === 0) {
    const scope = [
      branchFilter ? `branch=${branchFilter}` : null,
      repositoryFilter ? `repository=${repositoryFilter}` : null,
    ].filter(Boolean).join(' ');
    return scope.length > 0 ? `(no indexed commits for ${scope})` : '(no indexed commits)';
  }
  const headerLines: string[] = [];
  if (repoReaders.size > 1) {
    headerLines.push(`registered repositories: ${[...repoReaders.keys()].join(', ')}`);
    headerLines.push(`default for search tools (repository omitted): ${currentRepository ?? '(none)'}`);
  } else if (repoReaders.size === 1) {
    const only = [...repoReaders.keys()][0];
    headerLines.push(`registered repository: ${only}`);
  } else if (currentRepository !== null) {
    headerLines.push(`current repository: ${currentRepository}`);
  }
  const header = headerLines.length > 0 ? `${headerLines.join('\n')}\n---\n` : '';
  const body = rows.map(r =>
    `${r.commitSha}  repository=${r.repository || '(none)'}  branch=${r.branch}  ` +
    `indexed_at=${r.indexedAt.toISOString()}  model=${r.embedModel}  ` +
    `files=${r.fileCount}  chunks=${r.chunkCount}`,
  ).join('\n');
  return header + body;
}
