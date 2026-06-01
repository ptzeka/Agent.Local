// Shared "what commit am I searching?" resolution for the three search tools.
// Picks the effective repository (explicit input → server-detected current →
// any) and the effective commit SHA (explicit input → latest indexed for the
// branch+repository pair), and renders the header that the tools prepend to
// their output so the caller can see which slice of the index they got.

import type { DbConnection } from '../db/types.js';
import type { PgReaderRepository } from '../db/pgRepository.js';

/** Enough rows to detect multiple SHAs for one repo+branch; not a hard cap on index size. */
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

/**
 * Resolves to a concrete commit SHA + the labels the tools print in the
 * response header. Returns a `missing` result (with a user-facing message) when
 * no commit matches — callers should return that message verbatim instead of
 * querying chunks against a nonexistent commit.
 *
 * Repository precedence: explicit input > server-detected. If neither is set,
 * we refuse the query — searching "any repository" silently picks whatever
 * happens to be indexed and leads to the agent reasoning about the wrong code.
 * The returned message tells the caller exactly how to recover (pass
 * `repository`, or call `list_commits` to see what's available).
 *
 * When several distinct commit SHAs are indexed for the same repository **and**
 * git branch, omitting \`commit\` is ambiguous — the tool refuses until the
 * caller passes an explicit full SHA (from \`list_commits\` or the user).
 * Detection uses up to {@link COMMIT_RESOLUTION_ROW_CAP} newest rows per query.
 */
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

  // `--branch` is a single global default; indexed snapshots record the real
  // git branch name. When they differ (common in multi-repo MCP configs),
  // fall back to the newest indexed commit for this repository on any branch.
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

/**
 * One-line header all three search tools prepend so the caller can see which
 * repository / branch / commit was actually queried.
 */
export function formatResolutionHeader(resolved: Extract<ResolveCommitResult, { kind: 'resolved' }>): string {
  // `repository` can no longer be null on a resolved result — `resolveCommit`
  // refuses unknown-repo queries up front. The fallback is defensive only.
  const repoLabel = resolved.repository ?? '(unknown)';
  const shortSha = resolved.commitSha.slice(0, 12);
  return `repository: ${repoLabel}  branch: ${resolved.branch}  commit: ${shortSha}\n---\n`;
}
