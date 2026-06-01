import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export type EmbedProvider = 'local' | 'voyage' | 'openai';
export type Backend = 'pg' | 'file';

/**
 * Effective configuration used at runtime. Three sources, in a strict
 * precedence order — no env-var fallbacks, no implicit autodetection:
 *
 *   - CLI flags (with defaults)  → backend, branch, embedProvider, embedDim
 *   - Config file                → connectionString, excludeGlobs
 *   - `--root <path>` / process.cwd() → rootDir (what to index)
 *
 * File-backend data always lives at `<package-root>/data` — there is no
 * `--file-dir` flag. Keep the file backend simple: write to the folder next
 * to the binary, manually copy to codemcp's `data/` to consume.
 */
export interface CodeIndexConfig {
  backend: Backend;
  branch: string;
  embedProvider: EmbedProvider;
  embedDim: number;
  fileDir: string;
  rootDir: string;
  connectionString: string;
  excludeGlobs: string[];
  /**
   * Optional repository identifier override. When unset, the publisher
   * uses `owner/repo` from `git config --get remote.origin.url` when
   * available, otherwise the resolved absolute path of `rootDir`.
   */
  repository?: string;
}

/** Overrides supplied by the CLI. Anything undefined falls back to the default below. */
export interface CliOverrides {
  configPath?: string;
  /** Absolute path to the tree to index; when omitted, `process.cwd()` is used. */
  rootDir?: string;
  backend?: Backend;
  branch?: string;
  embedProvider?: EmbedProvider;
  embedDim?: number;
  repository?: string;
}

interface ConfigFileShape {
  connectionString?: string;
  excludeGlobs?: string[];
}

const DEFAULTS = {
  backend: 'pg' as Backend,
  branch: 'main',
  embedProvider: 'local' as EmbedProvider,
  embedDim: 768,
  connectionString: 'postgres://codeindex_user:CHANGE_ME@localhost:5432/codeindex',
  excludeGlobs: [
    '**/node_modules/**',
    '**/dist/**',
    '**/bin/**',
    '**/obj/**',
    '**/publish/**',
    '**/.git/**',
  ] as string[],
};

/**
 * Path to the package root (the directory that contains `dist/`, `migrations/`,
 * `package.json`). Used as the home for the default file-backend data folder.
 */
export function packageRoot(): string {
  // import.meta.url at runtime points at the compiled file under dist/. From
  // dist/config.js, the package root is one directory up.
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

export function defaultFileDir(): string {
  return resolve(packageRoot(), 'data');
}

export function loadConfig(overrides: CliOverrides = {}): CodeIndexConfig {
  const cwd = process.cwd();
  const rootDir =
    overrides.rootDir !== undefined ? resolve(cwd, overrides.rootDir) : cwd;

  const configFilePath = overrides.configPath
    ? resolve(cwd, overrides.configPath)
    : resolve(rootDir, 'codeindex.config.json');

  let fromFile: ConfigFileShape = {};
  if (existsSync(configFilePath)) {
    const raw = readFileSync(configFilePath, 'utf-8');
    fromFile = JSON.parse(raw) as ConfigFileShape;
  }

  const config: CodeIndexConfig = {
    backend: overrides.backend ?? DEFAULTS.backend,
    branch: overrides.branch ?? DEFAULTS.branch,
    embedProvider: overrides.embedProvider ?? DEFAULTS.embedProvider,
    embedDim: overrides.embedDim ?? DEFAULTS.embedDim,
    fileDir: defaultFileDir(),
    rootDir,
    connectionString: fromFile.connectionString ?? DEFAULTS.connectionString,
    excludeGlobs: fromFile.excludeGlobs ?? DEFAULTS.excludeGlobs,
  };
  if (overrides.repository !== undefined) {
    config.repository = overrides.repository;
  }
  return config;
}
