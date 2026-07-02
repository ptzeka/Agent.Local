import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EmbedProvider } from '@agent-local/vectorizer';

export type Backend = 'pg' | 'file';

// strict precedence with no env fallbacks or autodetection: CLI flags, then config file, then --root/cwd
// file-backend data always lives at <package-root>/data (no --file-dir flag) to keep that backend simple
export interface CodeIndexConfig {
  backend: Backend;
  branch: string;
  embedProvider: EmbedProvider;
  embedDim: number;
  fileDir: string;
  rootDir: string;
  connectionString: string;
  excludeGlobs: string[];
  // unset → publisher derives owner/repo from git remote, else the absolute rootDir
  repository?: string;
}

export interface CliOverrides {
  configPath?: string;
  // tree to index; omitted → process.cwd()
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
    // the file backend's own store — without this a republish indexes the previous snapshot's json
    '**/data/**',
  ] as string[],
};

// home for the default file-backend data folder
export function packageRoot(): string {
  // import.meta.url resolves under dist/ at runtime, so the package root is one directory up
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

export function defaultFileDir(): string {
  return resolve(packageRoot(), 'data');
}

// repo-first layout: every repository keeps its snapshots + migration journal in its own
// subtree, data/<owner>/<repo>/, so one data dir can host many indexed repositories
export function repoScopedFileDir(fileDir: string, repositoryId: string): string {
  const segments = repositoryId.split('/').filter(s => s.length > 0);
  return resolve(fileDir, ...segments);
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
