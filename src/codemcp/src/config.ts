import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { listIndexedRepositoryIds } from './db/file/fileRepository.js';

export type Backend = 'pg' | 'file';
export type EmbedProvider = 'local' | 'voyage' | 'openai';

/**
 * A single repository registered at startup via `--repository name` or `--repository name:localPath`.
 *
 * `name` — owner/repo identifier used in commit.json (e.g. "Platform/Rxo.Platform.Web.Sandbox").
 *
 * **Name-only** (no `:`): if `tools/codeindex/data/schema_versions.json` exists next to this
 * package (sibling `codeindex`), file data is read from **`../codeindex/data`** (shared with
 * `codeindex publish` — no copy step). Otherwise falls back to
 * `{packageRoot}/data/{...name.split('/')}`.
 *
 * **With `localPath`**: data at `{localPath}/.codemcp/data/{...name.split('/')}`.
 *
 * Pass multiple registrations by repeating `--repository`, or one flag with
 * values separated by `;` (see {@link parseRepositoryArgList}).
 */
export interface RepositoryEntry {
  name: string;
  /** When set, index files live under `{localPath}/.codemcp/data/...`. When omitted, under `{packageRoot}/data/...`. */
  localPath?: string;
}

/**
 * Computes the file-backend data directory for a repository entry.
 * Name-only: prefer sibling **`../codeindex/data`** when it already has migrations;
 * else `{packageRoot}/data/{segment0}/...`.
 * With localPath: `{localPath}/.codemcp/data/{segment0}/...`
 * Commit dirs live under `{fileDir}/commits/<sha>/` (nested) or `{fileDir}/<sha>/` (flat).
 */
export function repoFileDir(entry: RepositoryEntry): string {
  const segments = entry.name.split('/').filter(s => s.length > 0);
  const lp = entry.localPath?.trim();
  if (!lp) {
    const codeindexData = join(packageRoot(), '..', 'codeindex', 'data');
    if (existsSync(join(codeindexData, 'schema_versions.json'))) {
      return codeindexData;
    }
    return join(packageRoot(), 'data', ...segments);
  }
  return join(lp, '.codemcp', 'data', ...segments);
}

/**
 * Effective configuration used at runtime. Sources:
 *
 *   - CLI flags (with defaults)  → backend, branch, embedProvider, embedDim,
 *                                  expectedMigration, repositories
 *   - Config file                → connectionString (also overridable via --pg-dsn)
 *
 * Config file is resolved relative to process.cwd() (default
 * ./codemcp.config.json, or whatever --config <path> points at). No
 * environment-variable fallbacks.
 *
 * File-backend data: with `--repository owner/name` only, under `{packageRoot}/data/{name}/`;
 * with `name:localPath`, under `{localPath}/.codemcp/data/{name}/`.
 * Pass `--repository` once per repo (repeatable), or `name:path` entries separated by `;`.
 */
export interface CodeMcpConfig {
  backend: Backend;
  branch: string;
  embedProvider: EmbedProvider;
  embedDim: number;
  /** Legacy single-repo file dir (resolved from packageRoot when no --repository flags given). */
  fileDir: string;
  expectedMigration: string;
  connectionString: string;
  /** Repositories registered at startup (may be empty for backward-compat single-repo mode). */
  repositories: RepositoryEntry[];
}

/** Overrides supplied by the CLI. Anything undefined falls back to the default below. */
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

/**
 * Default on-disk index root for the file backend when no `--repository` flags
 * are given: sibling `tools/codeindex/data` if migrated there, else
 * {@link defaultFileDir}.
 */
export function resolveDefaultFileBackendBaseDir(): string {
  const codeindexData = join(packageRoot(), '..', 'codeindex', 'data');
  if (existsSync(join(codeindexData, 'schema_versions.json'))) {
    return codeindexData;
  }
  return defaultFileDir();
}

/**
 * When `--backend file` and no `--repository` entries were passed, scan the
 * default file index directory for distinct `repository` ids in published
 * commits and treat each as a registered name-only repo (same layout as
 * repeating `--repository` for each id). Explicit CLI registrations always win.
 */
export function discoverFileRepositoriesIfUnset(config: CodeMcpConfig): CodeMcpConfig {
  if (config.backend !== 'file') return config;
  if (config.repositories.length > 0) return config;

  const base = resolveDefaultFileBackendBaseDir();
  if (!existsSync(join(base, 'schema_versions.json'))) {
    return config;
  }

  const ids = listIndexedRepositoryIds(base);
  if (ids.length === 0) return config;

  return {
    ...config,
    repositories: ids.map((name) => ({ name })),
  };
}

/**
 * Parses a single `--repository` value: `owner/repo` (name-only) or `name:localPath`.
 * With a colon, the separator is the FIRST colon after a non-empty name so
 * `owner/name:C:\...` keeps the drive letter in `localPath`.
 */
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

/**
 * Parses one or more repository specs from a single `--repository`
 * argument. Multiple entries are separated by **`;`** (spaces cannot be used as
 * separators because `localPath` may contain spaces). Each entry is `owner/name`
 * or `owner/name:localPath`.
 */
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
