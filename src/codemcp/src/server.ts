#!/usr/bin/env node
import { Command, Option } from 'commander';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import {
  loadConfig,
  parseRepositoryArgList,
  discoverFileRepositoriesIfUnset,
  resolveDefaultFileBackendBaseDir,
  type Backend,
  type CliOverrides,
  type CodeMcpConfig,
  type EmbedProvider,
  type RepositoryEntry,
} from './config.js';
import { wireReader, wireMultiRepoReaders } from './wiring.js';
import type { PgReaderRepository } from './db/pgRepository.js';
import { createQueryEmbedAdapter } from './embed.js';
import type { DbConnectionFactory } from './db/types.js';
import { TOOLS, findTool, type ToolDeps } from './tools/registry.js';
import { detectCurrentRepository } from './git.js';

async function buildDeps(config: CodeMcpConfig): Promise<{
  factory: DbConnectionFactory;
  repo: PgReaderRepository;
  deps: ToolDeps;
  currentRepository: string | null;
}> {
  const { factory, repo } = wireReader(config);
  const embedder = createQueryEmbedAdapter(config.embedProvider, config.embedDim);

  // Build per-repo readers for the file backend (multi-repo mode).
  const repoReaders = config.backend === 'file' && config.repositories.length > 0
    ? wireMultiRepoReaders(config)
    : new Map<string, { factory: DbConnectionFactory; repo: PgReaderRepository }>();

  // Verify schema for each configured repo (file backend) or the primary backend.
  if (config.backend === 'file' && repoReaders.size > 0) {
    for (const [repoName, reader] of repoReaders) {
      await verifySchema(reader.factory, reader.repo, config.expectedMigration, repoName);
    }
  } else {
    await verifySchema(factory, repo, config.expectedMigration, null);
  }

  // Default repo when a tool call omits `repository`: match cwd git origin to
  // a registered name when possible, else the first registration / discovery order.
  const currentRepository = ((): string | null => {
    if (config.repositories.length === 0) {
      return detectCurrentRepository(process.cwd());
    }
    const registered = new Set(config.repositories.map((r) => r.name));
    const fromGit = detectCurrentRepository(process.cwd());
    if (fromGit !== null && registered.has(fromGit)) return fromGit;
    return config.repositories[0]?.name ?? null;
  })();

  const deps: ToolDeps = {
    factory,
    repo,
    embedder,
    defaultBranch: config.branch,
    currentRepository,
    repoReaders,
  };
  return { factory, repo, deps, currentRepository };
}

async function verifySchema(
  factory: DbConnectionFactory,
  repo: PgReaderRepository,
  expected: string,
  repoLabel: string | null,
): Promise<void> {
  const label = repoLabel ? ` (${repoLabel})` : '';
  await using conn = await factory.getConnection();
  const latest = await repo.getLatestAppliedMigration(conn);
  if (latest === null) {
    const base = 'baseDir' in factory && typeof (factory as { baseDir?: string }).baseDir === 'string'
      ? (factory as { baseDir: string }).baseDir
      : '(unknown)';
    throw new Error(
      `codemcp refuses to start${label}: no migrations have been applied (missing or empty ` +
      `schema_versions.json under ${base}). ` +
      `From the monorepo: \`cd tools/codeindex && npm run migrate:file && npm run publish:file\` ` +
      `(writes tools/codeindex/data/). Name-only \`--repository\` reads that folder automatically when present.`,
    );
  }
  if (latest < expected) {
    throw new Error(
      `codemcp expected migration >= ${expected}, found ${latest}${label}. ` +
      `Run \`codeindex migrate\` to bring the backend up to date.`,
    );
  }
}

async function serve(overrides: CliOverrides): Promise<void> {
  const rawConfig = loadConfig(overrides);
  const config = discoverFileRepositoriesIfUnset(rawConfig);
  if (
    config.backend === 'file' &&
    rawConfig.repositories.length === 0 &&
    config.repositories.length > 0
  ) {
    const names = config.repositories.map((r) => r.name).join(', ');
    process.stderr.write(
      `codemcp: auto-discovered ${config.repositories.length} repository id(s) from the file index ` +
      `(${resolveDefaultFileBackendBaseDir()}): ${names}. ` +
      `Omit \`--repository\` in MCP args when all live in this data tree.\n`,
    );
  }
  const { factory, deps, currentRepository } = await buildDeps(config);

  const repoList = config.repositories.length > 0
    ? config.repositories
      .map((r) => `${r.name}@${r.localPath?.trim() ? r.localPath : '<tools/codemcp/data>'}`)
      .join(', ')
    : '(auto-detect)';

  process.stderr.write(
    `codemcp: serving stdio MCP — backend=${config.backend} ` +
    `branch=${config.branch} repository=${currentRepository ?? '(none detected)'} ` +
    `repositories=${repoList} ` +
    `cwd=${process.cwd()} ` +
    `embed=${config.embedProvider}-${config.embedDim}\n`,
  );
  if (currentRepository === null && config.repositories.length === 0) {
    process.stderr.write(
      `codemcp: WARN no repository auto-detected from cwd — every tool call must pass ` +
      `\`repository\` explicitly. Pass \`--repository owner/name\` or \`--repository name:localPath\` at startup, ` +
      `set \`cwd\` in the MCP launcher config to the repo root, ` +
      `or expect the agent to resolve the repo from chat context per call.\n`,
    );
  }
  if (config.backend === 'file' && config.repositories.length > 1) {
    const names = config.repositories.map((r) => r.name).join(', ');
    process.stderr.write(
      `codemcp: ${config.repositories.length} file-backend repos registered (${names}). ` +
      `Each is searchable: pass tool argument repository="<name>" (see names above). ` +
      `If omitted, search_code / find_symbol / get_file_context use git origin when it matches a name, ` +
      `else the first: "${currentRepository ?? ''}". ` +
      `list_commits with no repository filter aggregates all.\n`,
    );
  }

  const server = new Server(
    { name: 'codemcp', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = findTool(request.params.name);
    if (!tool) {
      return {
        content: [{ type: 'text' as const, text: `unknown tool: ${request.params.name}` }],
        isError: true,
      };
    }
    try {
      const text = await tool.handler(request.params.arguments ?? {}, deps);
      return { content: [{ type: 'text' as const, text }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `${tool.name} failed: ${(err as Error).message}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = async (): Promise<void> => {
    try { await factory.end(); } catch { /* ignore */ }
    for (const reader of deps.repoReaders.values()) {
      try { await reader.factory.end(); } catch { /* ignore */ }
    }
    process.exit(0);
  };
  process.on('SIGINT', () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });
}

async function probe(overrides: CliOverrides, toolName: string, argsJson: string | undefined): Promise<void> {
  const config = discoverFileRepositoriesIfUnset(loadConfig(overrides));
  const tool = findTool(toolName);
  if (!tool) {
    process.stderr.write(`unknown tool: ${toolName}\n`);
    process.stderr.write(`available tools: ${TOOLS.map(t => t.name).join(', ')}\n`);
    process.exit(2);
  }
  let parsedArgs: unknown = {};
  if (argsJson !== undefined && argsJson.length > 0) {
    try {
      parsedArgs = JSON.parse(argsJson);
    } catch (err) {
      throw new Error(`Invalid JSON for tool args: ${(err as Error).message}`);
    }
  }
  const { factory, deps } = await buildDeps(config);
  try {
    const text = await tool.handler(parsedArgs, deps);
    process.stdout.write(text + '\n');
  } finally {
    await factory.end();
    for (const reader of deps.repoReaders.values()) {
      try { await reader.factory.end(); } catch { /* ignore */ }
    }
  }
}

async function listToolsCommand(): Promise<void> {
  for (const t of TOOLS) {
    process.stdout.write(`${t.name}\n  ${t.description}\n`);
    const props = (t.inputSchema as { properties?: Record<string, { type?: string; description?: string }>; required?: string[] });
    const required = new Set(props.required ?? []);
    if (props.properties) {
      for (const [name, schema] of Object.entries(props.properties)) {
        const req = required.has(name) ? ' (required)' : '';
        process.stdout.write(`  - ${name}: ${schema.type ?? 'any'}${req}${schema.description ? ` — ${schema.description}` : ''}\n`);
      }
    }
    process.stdout.write('\n');
  }
}

function parseDim(input: string): number {
  const n = Number(input);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new Error(`--embed-dim must be a positive integer (got: ${input})`);
  }
  return n;
}

const program = new Command();

program
  .name('codemcp')
  .description('Model Context Protocol server exposing the codeindex store to coding assistants.')
  .option('-c, --config <path>', 'path to codemcp.config.json (defaults to ./codemcp.config.json in cwd)')
  .addOption(new Option('-b, --backend <backend>', 'storage backend').choices(['pg', 'file']).default('pg'))
  .option('--branch <branch>', 'default branch to query', 'main')
  .addOption(new Option('--embed-provider <provider>', 'embedding model provider').choices(['local', 'voyage', 'openai']).default('local'))
  .option('--embed-dim <n>', 'embedding dimensionality (must match the indexed commit)', (v) => parseDim(v), 768)
  .option('--pg-dsn <dsn>', 'Postgres connection string (overrides connectionString from the config file). Prefer this for secrets — pass it via the launching tool, do not commit.')
  .option('--expected-migration <name>', 'minimum applied migration the server requires at startup', '002_add_repository.sql')
  .option(
    '--repository <nameOrName:path>',
    'Register one or more repositories. Name-only: "owner/name" → file data under tools/codemcp/data/{name}/. ' +
    'Or "owner/name:absoluteLocalPath" → {localPath}/.codemcp/data/{name}/. Repeat the flag, ' +
    'or pass several entries in one value separated by `;` (not spaces — paths can contain spaces). ' +
    'The first entry becomes the fallback default when git origin does not match a registered name. ' +
    'Omit all `--repository` flags to auto-register every repository id found in the file index (see README).',
    (val: string, acc: RepositoryEntry[]) => [...acc, ...parseRepositoryArgList(val)],
    [] as RepositoryEntry[],
  );

interface RawOpts {
  config?: string;
  backend: Backend;
  branch: string;
  embedProvider: EmbedProvider;
  embedDim: number;
  pgDsn?: string;
  expectedMigration: string;
  repository: RepositoryEntry[];
}

function readOverrides(): CliOverrides {
  const opts = program.opts<RawOpts>();
  const overrides: CliOverrides = {
    backend: opts.backend,
    branch: opts.branch,
    embedProvider: opts.embedProvider,
    embedDim: opts.embedDim,
    expectedMigration: opts.expectedMigration,
    repositories: opts.repository,
  };
  if (opts.config !== undefined) overrides.configPath = opts.config;
  if (opts.pgDsn !== undefined) overrides.pgDsn = opts.pgDsn;
  return overrides;
}

program
  .command('serve', { isDefault: true })
  .description('Start the stdio MCP server (default).')
  .action(async () => {
    await serve(readOverrides());
  });

program
  .command('probe <tool> [argsJson]')
  .description('Invoke a single tool from the command line and print its result. Bypasses the MCP transport — for local debugging.')
  .action(async (toolName: string, argsJson?: string) => {
    await probe(readOverrides(), toolName, argsJson);
  });

program
  .command('tools')
  .description('List available tools and their input schemas.')
  .action(async () => {
    await listToolsCommand();
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  const e = err as { message?: string; code?: string };
  const msg = e?.message || e?.code || (typeof err === 'string' ? err : '') || 'unknown error';
  process.stderr.write(`codemcp: ${msg}\n`);
  process.exit(1);
});
