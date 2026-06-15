import { z } from 'zod';
import type { DbConnectionFactory } from '../db/types.js';
import type { PgReaderRepository } from '../db/pgRepository.js';
import type { IVectorService } from '@agent-local/vectorizer';
import { searchCode, searchCodeSchema } from './search_code.js';
import { findSymbol, findSymbolSchema } from './find_symbol.js';
import { getFileContext, getFileContextSchema } from './get_file_context.js';
import { listCommits, listCommitsSchema } from './list_commits.js';

export interface ToolDeps {
  factory: DbConnectionFactory;
  repo: PgReaderRepository;
  embedder: IVectorService;
  defaultBranch: string;
  // default repo filter when a call omits `repository`; null means unknown, so resolveCommit
  // refuses to search "any repository" rather than guessing a name
  currentRepository: string | null;
  // per-repository readers for the file backend in multi-repo mode, keyed by repository name; empty otherwise
  repoReaders: Map<string, { factory: DbConnectionFactory; repo: PgReaderRepository }>;
}

// effective repo from explicit input then server default; mirrors resolveCommit so callers pick a reader first
export function effectiveRepo(
  repositoryInput: string | undefined,
  currentRepository: string | null,
): string | null {
  const explicit = repositoryInput?.trim();
  if (explicit && explicit.length > 0) return explicit;
  return currentRepository;
}

// reader pair for a repo name, falling back to the primary reader when the repo is not in repoReaders
export function pickReader(
  deps: ToolDeps,
  repoName: string | null,
): { factory: DbConnectionFactory; repo: PgReaderRepository } {
  if (repoName !== null && deps.repoReaders.has(repoName)) {
    return deps.repoReaders.get(repoName)!;
  }
  return { factory: deps.factory, repo: deps.repo };
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  zodSchema: z.ZodTypeAny;
  handler: (input: unknown, deps: ToolDeps) => Promise<string>;
}

export const TOOLS: ToolDef[] = [
  {
    name: 'search_code',
    description: 'Semantic vector search over the indexed repository. Returns ranked code chunks with file path, line range, and governing CLAUDE.md files. Output is prefixed with a `repository: ... branch: ... commit: ...` header so the caller can see which slice of the index was queried. With multiple registered repositories (explicit `--repository` flags or auto-discovered from the file index), pass `repository` to choose which index to query; omitted uses git origin when it matches a registered name, otherwise the first registration. Use this when you need to find code by meaning, not exact symbol.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language or code-fragment query.' },
        k: { type: 'integer', minimum: 1, maximum: 50, default: 8 },
        area: { type: 'string', enum: ['api', 'backend', 'frontend', 'db', 'test', 'docs', 'tools', 'pipeline', 'minikube', 'root'] },
        kind: { type: 'string', enum: ['class', 'method', 'function', 'component', 'interface', 'record', 'section', 'statement', 'message', 'service', 'rpc', 'file', 'window', 'module'] },
        language: { type: 'string' },
        repository: { type: 'string', description: 'Repository id to query (e.g. owner/repo), matching the indexer / `--repository` name. With several registered repos (CLI or auto-discovered from the file index), pass one of those names to pick that index. If omitted, defaults to git `origin` when it matches a registered name, else the first registration (file) or git-origin detection (otherwise). REQUIRED when auto-detection failed — the tool refuses rather than guess.' },
        commit: { type: 'string', description: 'Specific commit SHA. Defaults to the sole indexed snapshot on `--branch` for this repository when unambiguous. REQUIRED when more than one distinct SHA is indexed for the same repository and branch — use `list_commits` or ask the user, then pass the full SHA.' },
      },
      required: ['query'],
    },
    zodSchema: searchCodeSchema,
    handler: (input, deps) => searchCode(searchCodeSchema.parse(input), deps),
  },
  {
    name: 'find_symbol',
    description: 'Exact-match symbol lookup (class, function, component, message, etc.) across the indexed repository. Faster and more precise than search_code when you know the name. With multiple registered repositories, pass `repository` to select the index. Output is prefixed with a `repository: ... branch: ... commit: ...` header.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Exact symbol name.' },
        repository: { type: 'string', description: 'Repository id to query; must match a registered name when several exist (CLI or auto-discovered). Defaults to matching git `origin` when possible, else the first registration. REQUIRED when auto-detection failed.' },
        commit: { type: 'string', description: 'Specific commit SHA. Defaults to the sole indexed snapshot on `--branch` for this repository when unambiguous. REQUIRED when more than one distinct SHA is indexed for the same repository and branch — use `list_commits` or ask the user, then pass the full SHA.' },
      },
      required: ['name'],
    },
    zodSchema: findSymbolSchema,
    handler: (input, deps) => findSymbol(findSymbolSchema.parse(input), deps),
  },
  {
    name: 'get_file_context',
    description: 'Return all chunks for a given file plus the governing CLAUDE.md files. Use this to understand a file before editing it. With multiple registered repositories, pass `repository` to select the index. Output is prefixed with a `repository: ... branch: ... commit: ...` header.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Repository-relative path, forward slashes.' },
        repository: { type: 'string', description: 'Repository id to query; must match a registered name when several exist (CLI or auto-discovered). Defaults to matching git `origin` when possible, else the first registration. REQUIRED when auto-detection failed.' },
        commit: { type: 'string', description: 'Specific commit SHA. Defaults to the sole indexed snapshot on `--branch` for this repository when unambiguous. REQUIRED when more than one distinct SHA is indexed for the same repository and branch — use `list_commits` or ask the user, then pass the full SHA.' },
      },
      required: ['path'],
    },
    zodSchema: getFileContextSchema,
    handler: (input, deps) => getFileContext(getFileContextSchema.parse(input), deps),
  },
  {
    name: 'list_commits',
    description: 'Enumerate indexed commit snapshots. With multiple file-backend registrations and no `repository` filter, aggregates across all of them. Use this to discover which repository names and commits are available before calling search_code / find_symbol / get_file_context.',
    inputSchema: {
      type: 'object',
      properties: {
        branch: { type: 'string', description: 'Restrict to a single branch.' },
        repository: { type: 'string', description: 'Restrict to one registered repository name. Omit to include every registered repo when using file multi-repo (explicit or auto-discovered).' },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
      },
    },
    zodSchema: listCommitsSchema,
    handler: (input, deps) => listCommits(listCommitsSchema.parse(input), deps),
  },
];

export function findTool(name: string): ToolDef | undefined {
  return TOOLS.find(t => t.name === name);
}
