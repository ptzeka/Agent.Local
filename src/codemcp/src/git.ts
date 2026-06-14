// Git-context detection for the reader. Strict by design: if the repo can't be read from git we return
// null and force the caller to pass `repository` or ask — a wrong default silently mis-targets every query.
// parseRepositoryFromOriginUrl is duplicated from codeindex/src/publisher/git.ts; keep them in lock-step.

import { execSync } from 'node:child_process';

// repository id for rootDir in owner/repo form from remote.origin.url; null when unavailable —
// callers must treat null as unknown and never guess (the launching tool's cwd is rarely the repo root)
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

// pulls the "owner/repo" tail out of an origin URL (HTTPS, SSH, Azure DevOps); exported for unit testing
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
