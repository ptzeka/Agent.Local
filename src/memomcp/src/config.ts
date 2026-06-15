import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { EmbedProvider } from '@agent-local/vectorizer';

export type Backend = 'pg' | 'file';

// CLI flags + an optional config file (connectionString, also via --pg-dsn) resolved from cwd, no env fallbacks
export interface MemoMcpConfig {
  backend: Backend;
  embedProvider: EmbedProvider;
  embedDim: number;
  // collection used when a tool call omits `collection`; an opaque partition id (user/session/topic)
  defaultCollection: string;
  // file-backend root holding memories/<collection>/records.jsonl
  baseDir: string;
  connectionString: string;
}

export interface CliOverrides {
  configPath?: string;
  backend?: Backend;
  embedProvider?: EmbedProvider;
  embedDim?: number;
  defaultCollection?: string;
  baseDir?: string;
  pgDsn?: string;
}

interface ConfigFileShape {
  connectionString?: string;
}

const DEFAULTS = {
  // memory is local-first, so the file backend is the default (codemcp defaults to pg, memory does not)
  backend: 'file' as Backend,
  // paraphrase recall needs a real model; local hashed bag-of-words can't do it (BACKLOG M3-7)
  embedProvider: 'voyage' as EmbedProvider,
  embedDim: 1024,
  defaultCollection: 'default',
  connectionString: 'postgres://memomcp_user:CHANGE_ME@localhost:5432/memomcp',
};

export function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

export function defaultBaseDir(): string {
  return resolve(packageRoot(), 'data');
}

export function loadConfig(overrides: CliOverrides = {}): MemoMcpConfig {
  const cwd = process.cwd();

  const configFilePath = overrides.configPath
    ? resolve(cwd, overrides.configPath)
    : resolve(cwd, 'memomcp.config.json');

  let fromFile: ConfigFileShape = {};
  if (existsSync(configFilePath)) {
    const raw = readFileSync(configFilePath, 'utf-8');
    fromFile = JSON.parse(raw) as ConfigFileShape;
  }

  return {
    backend: overrides.backend ?? DEFAULTS.backend,
    embedProvider: overrides.embedProvider ?? DEFAULTS.embedProvider,
    embedDim: overrides.embedDim ?? DEFAULTS.embedDim,
    defaultCollection: overrides.defaultCollection ?? DEFAULTS.defaultCollection,
    baseDir: overrides.baseDir ? resolve(cwd, overrides.baseDir) : defaultBaseDir(),
    connectionString: overrides.pgDsn ?? fromFile.connectionString ?? DEFAULTS.connectionString,
  };
}
