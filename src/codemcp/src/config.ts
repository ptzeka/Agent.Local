import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { EmbedProvider } from '@agent-local/vectorizer';

import { listIndexedRepositoryIds } from './metadata/fileMetadataRepository.js';

export type Backend = 'pg' | 'file';

// registered at startup via --repository name or name:localPath; name is the owner/repo id used in commit.json
export interface RepositoryEntry {
  name: string;
  // set → index files under {localPath}/.codemcp/data/...; omitted → under {packageRoot}/data/...
  localPath?: string;
}

// repo-first layout everywhere: a repository's data root is <dataRoot>/<owner>/<repo>/.
// Name-only prefers the sibling ../codeindex/data subtree when codeindex published there
export function repoFileDir(entry: RepositoryEntry): string {
  const segments = entry.name.split('/').filter(s => s.length > 0);
  const lp = entry.localPath?.trim();
  if (!lp) {
    const codeindexRepoDir = join(packageRoot(), '..', 'codeindex', 'data', ...segments);
    if (existsSync(join(codeindexRepoDir, 'schema_versions.json'))) {
      return codeindexRepoDir;
    }
    return join(packageRoot(), 'data', ...segments);
  }
  return join(lp, '.codemcp', 'data', ...segments);
}

// CLI flags + config file (connectionString, also via --pg-dsn) resolved from cwd, no env fallbacks
export interface CodeMcpConfig {
  backend: Backend;
  branch: string;
  embedProvider: EmbedProvider;
  embedDim: number;
  // legacy single-repo dir, used when no --repository flags are given
  fileDir: string;
  expectedMigration: string;
  connectionString: string;
  // may be empty for backward-compat single-repo mode
  repositories: RepositoryEntry[];
}

export interface CliOverrides {
  configPath?: string;
  backend?: Backend;
  branch?: string;
  embedProvider?: EmbedProvider;
  embedDim?: number;
  pgDsn?: string;
  expectedMigration?: string;
  repositories?: RepositoryEntry[];
}

interface ConfigFileShape {
  connectionString?: string;
}

const DEFAULTS = {
  backend: 'pg' as Backend,
  branch: 'main',
  embedProvider: 'local' as EmbedProvider,
  embedDim: 768,
  expectedMigration: '002_add_repository.sql',
  connectionString: 'postgres://codeindex_user:CHANGE_ME@localhost:5432/codeindex',
};

export function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

export function defaultFileDir(): string {
  return resolve(packageRoot(), 'data');
}

// default file-backend data root with no --repository flags: sibling codeindex/data when it
// holds at least one repo-first subtree (<owner>/<repo>/schema_versions.json), else this package's
export function resolveDefaultFileBackendBaseDir(): string {
  const codeindexData = join(packageRoot(), '..', 'codeindex', 'data');
  if (listIndexedRepositoryIds(codeindexData).length > 0) {
    return codeindexData;
  }
  return defaultFileDir();
}

// with --backend file and no --repository, every <owner>/<repo>/ subtree under the data root
// becomes a name-only repo; explicit CLI wins
export function discoverFileRepositoriesIfUnset(config: CodeMcpConfig): CodeMcpConfig {
  if (config.backend !== 'file') return config;
  if (config.repositories.length > 0) return config;

  const ids = listIndexedRepositoryIds(resolveDefaultFileBackendBaseDir());
  if (ids.length === 0) return config;

  return {
    ...config,
    repositories: ids.map((name) => ({ name })),
  };
}

// splits on the FIRST colon after a non-empty name so owner/name:C:\... keeps the drive letter in localPath
export function parseRepositoryArg(raw: string): RepositoryEntry {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('Invalid --repository value: empty string.');
  }
  const idx = trimmed.indexOf(':');
  if (idx === -1) {
    return { name: trimmed };
  }
  const name = trimmed.slice(0, idx).trim();
  const localPath = trimmed.slice(idx + 1).trim();
  if (!name || !localPath) {
    throw new Error(`Invalid --repository value "${raw}": name and localPath must both be non-empty.`);
  }
  // a colon at index 1 with a slash after is a bare drive letter, not a name:path separator
  const isBareWindowsPath =
    idx === 1 &&
    trimmed.length > 2 &&
    /[A-Za-z]/.test(trimmed.charAt(0)) &&
    (trimmed.charAt(2) === '\\' || trimmed.charAt(2) === '/');
  if (isBareWindowsPath) {
    throw new Error(
      `Invalid --repository value "${raw}". Use "owner/name:${trimmed}" so the path is not parsed as a bare drive letter.`,
    );
  }
  return { name, localPath };
}

// entries are `;`-separated because spaces can't separate them — a localPath may contain spaces
export function parseRepositoryArgList(raw: string): RepositoryEntry[] {
  const segments = raw
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return segments.map((s) => parseRepositoryArg(s));
}

export function loadConfig(overrides: CliOverrides = {}): CodeMcpConfig {
  const cwd = process.cwd();

  const configFilePath = overrides.configPath
    ? resolve(cwd, overrides.configPath)
    : resolve(cwd, 'codemcp.config.json');

  let fromFile: ConfigFileShape = {};
  if (existsSync(configFilePath)) {
    const raw = readFileSync(configFilePath, 'utf-8');
    fromFile = JSON.parse(raw) as ConfigFileShape;
  }

  return {
    backend: overrides.backend ?? DEFAULTS.backend,
    branch: overrides.branch ?? DEFAULTS.branch,
    embedProvider: overrides.embedProvider ?? DEFAULTS.embedProvider,
    embedDim: overrides.embedDim ?? DEFAULTS.embedDim,
    fileDir: defaultFileDir(),
    expectedMigration: overrides.expectedMigration ?? DEFAULTS.expectedMigration,
    connectionString: overrides.pgDsn ?? fromFile.connectionString ?? DEFAULTS.connectionString,
    repositories: overrides.repositories ?? [],
  };
}
