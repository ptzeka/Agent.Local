import { realpathSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

export interface GitContext {
  commitSha: string;
  branch: string;
  isDirty: boolean;
  /**
   * Repository identifier: parsed from `remote.origin.url` when available
   * (`owner/repo`), else a stable id from the resolved filesystem path of
   * `rootDir` (forward slashes). Never blank.
   */
  repository: string;
}

export function readGitContext(rootDir: string, fallbackBranch: string, override?: string): GitContext {
  if (override && override.trim().length > 0) {
    const base = readGitContextNoRepo(rootDir, fallbackBranch);
    return { ...base, repository: override.trim() };
  }
  const base = readGitContextNoRepo(rootDir, fallbackBranch);
  const repository = detectRepositoryName(rootDir) ?? repositoryIdFromResolvedPath(rootDir);
  return { ...base, repository };
}

function readGitContextNoRepo(rootDir: string, fallbackBranch: string): Omit<GitContext, 'repository'> {
  try {
    const commitSha = run('git rev-parse HEAD', rootDir);
    let branch = run('git rev-parse --abbrev-ref HEAD', rootDir);
    if (branch === 'HEAD' || branch === '') branch = fallbackBranch;
    const status = run('git status --porcelain', rootDir);
    const isDirty = status.length > 0;
    return { commitSha, branch, isDirty };
  } catch {
    const synthetic = `nogit-${Date.now().toString(16)}`;
    return { commitSha: synthetic, branch: fallbackBranch, isDirty: false };
  }
}

/**
 * Stable repository key when git `origin` is missing: resolved absolute path
 * with symlinks collapsed, `/` separators (Windows-safe for matching).
 */
export function repositoryIdFromResolvedPath(rootDir: string): string {
  const absolute = resolve(rootDir);
  let canonical: string;
  try {
    canonical = realpathSync(absolute);
  } catch {
    canonical = absolute;
  }
  return canonical.replace(/\\/g, '/');
}

/**
 * Reads `git config --get remote.origin.url` and parses it to `owner/repo`
 * form. Returns null when the repo has no origin remote or git is unavailable;
 * the caller is expected to fall back to {@link repositoryIdFromResolvedPath}.
 */
export function detectRepositoryName(rootDir: string): string | null {
  let url: string;
  try {
    url = run('git config --get remote.origin.url', rootDir);
  } catch {
    return null;
  }
  if (!url) return null;
  return parseRepositoryFromOriginUrl(url);
}

/**
 * Pulls the "owner/repo" tail out of an origin URL. Handles the common Git
 * hosting URL shapes. Exported for unit testing.
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

function run(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
}
