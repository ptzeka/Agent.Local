import { z } from 'zod';
import type { IVectorService } from '@agent-local/vectorizer';
import type { WiredReader } from '../wiring.js';
import { searchCode, searchCodeSchema } from './search_code.js';
import { getSymbol, getSymbolSchema } from './get_symbol.js';
import { getRelationships, getRelationshipsSchema } from './get_relationships.js';
import { getFileContext, getFileContextSchema } from './get_file_context.js';
import { listCommits, listCommitsSchema } from './list_commits.js';
import { relatedCode, relatedCodeSchema } from './related_code.js';
import { locateCode, locateCodeSchema } from './locate_code.js';
import { locateSymbol, locateSymbolSchema } from './locate_symbol.js';
import { locateFile, locateFileSchema } from './locate_file.js';
import { expandChunk, expandChunkSchema } from './expand_chunk.js';

export interface ToolDeps {
  reader: WiredReader;
  embedder: IVectorService;
  defaultBranch: string;
  // default repo filter when a call omits `repository`; null means unknown, so resolveCommit
  // refuses to search "any repository" rather than guessing a name
  currentRepository: string | null;
  // per-repository readers for the file backend in multi-repo mode, keyed by repository name; empty otherwise
  repoReaders: Map<string, WiredReader>;
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
export function pickReader(deps: ToolDeps, repoName: string | null): WiredReader {
  if (repoName !== null && deps.repoReaders.has(repoName)) {
    return deps.repoReaders.get(repoName)!;
  }
  return deps.reader;
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
    name: 'get_symbol',
    description: 'Exact-match symbol lookup (class, function, component, message, etc.) across the indexed repository, returning each definition\'s full body. Faster and more precise than search_code when you know the name. With multiple registered repositories, pass `repository` to select the index. Output is prefixed with a `repository: ... branch: ... commit: ...` header.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Exact symbol name.' },
        repository: { type: 'string', description: 'Repository id to query; must match a registered name when several exist (CLI or auto-discovered). Defaults to matching git `origin` when possible, else the first registration. REQUIRED when auto-detection failed.' },
        commit: { type: 'string', description: 'Specific commit SHA. Defaults to the sole indexed snapshot on `--branch` for this repository when unambiguous. REQUIRED when more than one distinct SHA is indexed for the same repository and branch — use `list_commits` or ask the user, then pass the full SHA.' },
      },
      required: ['name'],
    },
    zodSchema: getSymbolSchema,
    handler: (input, deps) => getSymbol(getSymbolSchema.parse(input), deps),
  },
  {
    name: 'get_relationships',
    description: 'Relationship edges for an entity, from the per-commit edges.jsonl graph: who calls / imports / implements / extends it (incoming) and what it calls / imports / implements / extends (outgoing). Pass a symbol name (wireParser), an entity id (src/x.ts#Class.method), or a file path. Extracted from the AST for TS/JS; complements vector search, which cannot answer relationship questions. With multiple registered repositories, pass `repository`. Output is prefixed with a `repository: ... branch: ... commit: ...` header.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Symbol name (e.g. wireParser), entity id (path#Class.method), or file path.' },
        type: { type: 'string', enum: ['imports', 'calls', 'implements', 'extends'], description: 'Restrict to one edge type.' },
        direction: { type: 'string', enum: ['out', 'in', 'both'], default: 'both', description: 'out = what the entity calls/imports/implements; in = who calls/imports/implements it.' },
        repository: { type: 'string', description: 'Repository id to query; must match a registered name when several exist (CLI or auto-discovered). Defaults to matching git `origin` when possible, else the first registration. REQUIRED when auto-detection failed.' },
        commit: { type: 'string', description: 'Specific commit SHA. Defaults to the sole indexed snapshot on `--branch` for this repository when unambiguous. REQUIRED when more than one distinct SHA is indexed for the same repository and branch — use `list_commits` or ask the user, then pass the full SHA.' },
      },
      required: ['name'],
    },
    zodSchema: getRelationshipsSchema,
    handler: (input, deps) => getRelationships(getRelationshipsSchema.parse(input), deps),
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
    description: 'Enumerate indexed commit snapshots. With multiple file-backend registrations and no `repository` filter, aggregates across all of them. Use this to discover which repository names and commits are available before calling search_code / get_symbol / get_file_context.',
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
  {
    name: 'related_code',
    description: 'Find code related to a chunk you already have ("more like this"): ranks the index by semantic similarity to the seed chunk\'s own stored vector, excluding the seed itself. Pass the [path:start-end] citation of the seed (from any other tool). Pure similarity — use it to discover neighbours of a function/type without crafting a query. With multiple registered repositories, pass `repository`. Output is prefixed with a `repository: ... branch: ... commit: ...` header.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Repository-relative path of the seed chunk, from a [path:start-end] citation.' },
        startLine: { type: 'integer', minimum: 1, description: 'Seed chunk start line, from a [path:start-end] citation.' },
        endLine: { type: 'integer', minimum: 1, description: 'Seed chunk end line, from a [path:start-end] citation.' },
        k: { type: 'integer', minimum: 1, maximum: 50, default: 8 },
        area: { type: 'string', enum: ['api', 'backend', 'frontend', 'db', 'test', 'docs', 'tools', 'pipeline', 'minikube', 'root'] },
        kind: { type: 'string', enum: ['class', 'method', 'function', 'component', 'interface', 'record', 'section', 'statement', 'message', 'service', 'rpc', 'file', 'window', 'module'] },
        language: { type: 'string' },
        repository: { type: 'string', description: 'Repository id to query; must match a registered name when several exist (CLI or auto-discovered). Defaults to matching git `origin` when possible, else the first registration. REQUIRED when auto-detection failed.' },
        commit: { type: 'string', description: 'Specific commit SHA. Defaults to the sole indexed snapshot on `--branch` for this repository when unambiguous. REQUIRED when more than one distinct SHA is indexed for the same repository and branch — use `list_commits` or ask the user, then pass the full SHA.' },
      },
      required: ['path', 'startLine', 'endLine'],
    },
    zodSchema: relatedCodeSchema,
    handler: (input, deps) => relatedCode(relatedCodeSchema.parse(input), deps),
  },
  {
    name: 'locate_code',
    description: 'Cheap locate tier of two-tier retrieval: like search_code but returns content-free summaries (citation + symbol + score), not bodies. Use this first to scan many semantic candidates without pulling their content, then call expand_chunk on the [path:start-end] hits worth reading. With multiple registered repositories, pass `repository`. Output is prefixed with a `repository: ... branch: ... commit: ...` header.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language or code-fragment query.' },
        k: { type: 'integer', minimum: 1, maximum: 50, default: 12 },
        area: { type: 'string', enum: ['api', 'backend', 'frontend', 'db', 'test', 'docs', 'tools', 'pipeline', 'minikube', 'root'] },
        kind: { type: 'string', enum: ['class', 'method', 'function', 'component', 'interface', 'record', 'section', 'statement', 'message', 'service', 'rpc', 'file', 'window', 'module'] },
        language: { type: 'string' },
        repository: { type: 'string', description: 'Repository id to query; must match a registered name when several exist (CLI or auto-discovered). Defaults to matching git `origin` when possible, else the first registration. REQUIRED when auto-detection failed.' },
        commit: { type: 'string', description: 'Specific commit SHA. Defaults to the sole indexed snapshot on `--branch` for this repository when unambiguous. REQUIRED when more than one distinct SHA is indexed for the same repository and branch — use `list_commits` or ask the user, then pass the full SHA.' },
      },
      required: ['query'],
    },
    zodSchema: locateCodeSchema,
    handler: (input, deps) => locateCode(locateCodeSchema.parse(input), deps),
  },
  {
    name: 'locate_symbol',
    description: 'Exact-match locate tier: every definition of a symbol as content-free summaries (citation + line range). Like get_symbol but without bodies — use to see where a symbol lives, then expand_chunk the one you need. With multiple registered repositories, pass `repository`. Output is prefixed with a `repository: ... branch: ... commit: ...` header.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Exact symbol name.' },
        repository: { type: 'string', description: 'Repository id to query; must match a registered name when several exist (CLI or auto-discovered). Defaults to matching git `origin` when possible, else the first registration. REQUIRED when auto-detection failed.' },
        commit: { type: 'string', description: 'Specific commit SHA. Defaults to the sole indexed snapshot on `--branch` for this repository when unambiguous. REQUIRED when more than one distinct SHA is indexed for the same repository and branch — use `list_commits` or ask the user, then pass the full SHA.' },
      },
      required: ['name'],
    },
    zodSchema: locateSymbolSchema,
    handler: (input, deps) => locateSymbol(locateSymbolSchema.parse(input), deps),
  },
  {
    name: 'locate_file',
    description: 'Exact-match locate tier: a file\'s chunks as content-free summaries — an outline of its symbols and line ranges. Like get_file_context but without bodies; use to understand a file\'s shape, then expand_chunk (or get_file_context) the parts you need. With multiple registered repositories, pass `repository`. Output is prefixed with a `repository: ... branch: ... commit: ...` header.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Repository-relative path, forward slashes.' },
        repository: { type: 'string', description: 'Repository id to query; must match a registered name when several exist (CLI or auto-discovered). Defaults to matching git `origin` when possible, else the first registration. REQUIRED when auto-detection failed.' },
        commit: { type: 'string', description: 'Specific commit SHA. Defaults to the sole indexed snapshot on `--branch` for this repository when unambiguous. REQUIRED when more than one distinct SHA is indexed for the same repository and branch — use `list_commits` or ask the user, then pass the full SHA.' },
      },
      required: ['path'],
    },
    zodSchema: locateFileSchema,
    handler: (input, deps) => locateFile(locateFileSchema.parse(input), deps),
  },
  {
    name: 'expand_chunk',
    description: 'Expand tier of two-tier retrieval: return the full content behind one [path:start-end] citation that a locate_code / locate_symbol / locate_file result surfaced. The line range must match a citation exactly. With multiple registered repositories, pass `repository`. Output is prefixed with a `repository: ... branch: ... commit: ...` header.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Repository-relative path of the chunk, from a [path:start-end] citation.' },
        startLine: { type: 'integer', minimum: 1, description: 'Chunk start line, from a [path:start-end] citation.' },
        endLine: { type: 'integer', minimum: 1, description: 'Chunk end line, from a [path:start-end] citation.' },
        repository: { type: 'string', description: 'Repository id to query; must match a registered name when several exist (CLI or auto-discovered). Defaults to matching git `origin` when possible, else the first registration. REQUIRED when auto-detection failed.' },
        commit: { type: 'string', description: 'Specific commit SHA. Defaults to the sole indexed snapshot on `--branch` for this repository when unambiguous. REQUIRED when more than one distinct SHA is indexed for the same repository and branch — use `list_commits` or ask the user, then pass the full SHA.' },
      },
      required: ['path', 'startLine', 'endLine'],
    },
    zodSchema: expandChunkSchema,
    handler: (input, deps) => expandChunk(expandChunkSchema.parse(input), deps),
  },
];

export function findTool(name: string): ToolDef | undefined {
  return TOOLS.find(t => t.name === name);
}
