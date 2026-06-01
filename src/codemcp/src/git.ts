// Git-context detection for the reader.
//
// Only the URL parser ({@link parseRepositoryFromOriginUrl}) is duplicated from
// tools/codeindex/src/publisher/git.ts — keep those two implementations in
// lock-step. The entry point here intentionally diverges from the publisher:
// the publisher MUST always come up with a repository name (it has nothing to
// write into commit.json otherwise), so it falls back to basename(rootDir).
// The reader, by contrast, is strict: if we cannot read it from git, we return
// null and force the caller (the agent) to either pass `repository` explicitly
// or ask the user. A wrong default here silently mis-targets every query.

import { execSync } from 'node:child_process';

/**
 * Resolves the repository identifier for `rootDir` in `owner/repo` form by
 * reading `remote.origin.url` and parsing it via
 * {@link parseRepositoryFromOriginUrl}.
 *
 * Returns `null` when git is unavailable, the directory is not a git
 * repository, or the repository has no `origin` remote. Callers MUST treat
 * `null` as "unknown" — never substitute a guess (e.g. `basename(cwd)`),
 * because in practice the launching tool's cwd is rarely the repo root.
 */
export function detectCurrentRepository(rootDir: string): string | null {
  return readOriginRepository(rootDir);
}

function readOriginRepository(rootDir: string): string | null {
  let url: string;
  try {
    url = execSync('git config --get remote.origin.url', {
      cwd: rootDir,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
  } catch {
    return null;
  }
  if (!url) return null;
  return parseRepositoryFromOriginUrl(url);
}

/**
 * Pulls the "owner/repo" tail out of an origin URL. Handles the common Git
 * hosting URL shapes (HTTPS, SSH, Azure DevOps). Exported for unit testing.
 */
export function parseRepositoryFromOriginUrl(url: string): string | null {
  const stripped = url.trim().replace(/\.git$/i, '');
  if (!stripped) return null;

  let pathPart: string;
  if (stripped.includes('://')) {
    const afterScheme = stripped.split('://')[1] ?? '';
    const slashIdx = afterScheme.indexOf('/');
    pathPart = slashIdx >= 0 ? afterScheme.slice(slashIdx + 1) : '';
  } else if (/^[^/]+@[^/]+:/.test(stripped)) {
    pathPart = stripped.split(':').slice(1).join(':');
  } else {
    pathPart = stripped;
  }

  const segments = pathPart.split('/').filter(s => s.length > 0 && s !== '_git');
  if (segments.length === 0) return null;
  if (segments.length === 1) return segments[0] ?? null;
  return segments.slice(-2).join('/');
}
