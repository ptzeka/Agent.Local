// Shared commit/repository resolution for the search tools: picks the effective repo and commit SHA,
// and renders the header tools prepend so callers see which slice of the index they got.

import type { DbConnection } from '../db/types.js';
import type { PgReaderRepository } from '../db/pgRepository.js';

// enough rows to detect multiple SHAs for one repo+branch; not a hard cap on index size
const COMMIT_RESOLUTION_ROW_CAP = 500;

export interface ResolveCommitOptions {
  branch: string;
  repositoryInput: string | undefined;
  currentRepository: string | null;
  commitOverride: string | undefined;
}

export type ResolveCommitResult =
  | {
      kind: 'resolved';
      commitSha: string;
      branch: string;
      repository: string | null;
    }
  | {
      kind: 'missing';
      message: string;
    };

// Refuses rather than guesses: an unknown repo or several SHAs for one repo+branch returns a `missing`
// message telling the caller how to recover, so the agent never reasons about the wrong code.
export async function resolveCommit(
  conn: DbConnection,
  repo: PgReaderRepository,
  opts: ResolveCommitOptions,
): Promise<ResolveCommitResult> {
  const explicit = opts.repositoryInput?.trim();
  const repository = explicit && explicit.length > 0 ? explicit : opts.currentRepository;

  if (repository === null) {
    return {
      kind: 'missing',
      message:
        `(repository not specified and could not be auto-detected from the server's cwd. ` +
        `Pass \`repository\` explicitly — e.g. resolve it from the workspace's git origin, ` +
        `or call \`list_commits\` to see what is indexed, or ask the user which repo they mean. ` +
        `Do NOT retry without \`repository\` — the answer will not change.)`,
    };
  }

  if (opts.commitOverride) {
    return {
      kind: 'resolved',
      commitSha: opts.commitOverride,
      branch: opts.branch,
      repository,
    };
  }

  const ambiguousMessage = (
    repoLabel: string,
    branchLabel: string,
    shas: string[],
  ): string => {
    const preview = shas.slice(0, 8).map((s) => s.slice(0, 12)).join(', ');
    const more = shas.length > 8 ? ` (+${shas.length - 8} more)` : '';
    return (
      `(Multiple indexed commit SHAs exist for repository=${repoLabel} branch=${branchLabel}. ` +
      `Pass the tool argument \`commit\` with the full SHA for the snapshot you need ` +
      `(see \`list_commits\` with the same \`repository\` filter, or ask the user). ` +
      `Indexed candidates include: ${preview}${more}. ` +
      `Do NOT retry without \`commit\` — picking "latest" would hide which revision is queried.)`
    );
  };

  const onDefaultBranch = await repo.listCommits(
    conn,
    opts.branch,
    repository,
    COMMIT_RESOLUTION_ROW_CAP,
  );
  const distinctOnDefault = new Set(onDefaultBranch.map((r) => r.commitSha));
  if (distinctOnDefault.size > 1) {
    return {
      kind: 'missing',
      message: ambiguousMessage(repository, opts.branch, [...distinctOnDefault].sort()),
    };
  }
  if (onDefaultBranch.length > 0) {
    const latest = onDefaultBranch[0]!;
    return {
      kind: 'resolved',
      commitSha: latest.commitSha,
      branch: latest.branch,
      repository: latest.repository.length > 0 ? latest.repository : repository,
    };
  }

  // indexed snapshots record the real git branch, which often differs from the global --branch default
  const anyBranch = await repo.listCommits(conn, null, repository, COMMIT_RESOLUTION_ROW_CAP);
  if (anyBranch.length === 0) {
    return {
      kind: 'missing',
      message:
        `(no indexed commits for repository=${repository} — ` +
        `run \`codeindex publish\` from that repo first, or call \`list_commits\` ` +
        `to see which repository/branch pairs are indexed)`,
    };
  }

  const latest = anyBranch[0]!;
  const onPickedBranch = anyBranch.filter((r) => r.branch === latest.branch);
  const distinctOnPicked = new Set(onPickedBranch.map((r) => r.commitSha));
  if (distinctOnPicked.size > 1) {
    return {
      kind: 'missing',
      message: ambiguousMessage(repository, latest.branch, [...distinctOnPicked].sort()),
    };
  }

  return {
    kind: 'resolved',
    commitSha: latest.commitSha,
    branch: latest.branch,
    repository: latest.repository.length > 0 ? latest.repository : repository,
  };
}

// header the search tools prepend so the caller sees which repo/branch/commit was queried
export function formatResolutionHeader(resolved: Extract<ResolveCommitResult, { kind: 'resolved' }>): string {
  // repository is non-null on a resolved result; this fallback is defensive only
  const repoLabel = resolved.repository ?? '(unknown)';
  const shortSha = resolved.commitSha.slice(0, 12);
  return `repository: ${repoLabel}  branch: ${resolved.branch}  commit: ${shortSha}\n---\n`;
}
