#!/usr/bin/env node
import { Command, Option } from 'commander';
import { McpToolServer } from '@agent-local/mcp/tool-server';
import { PgVectorStore } from '@agent-local/vectorstore';

import {
  loadConfig,
  type Backend,
  type CliOverrides,
  type MemoMcpConfig,
} from './config.js';
import { wire } from './wiring.js';
import type { EmbedProvider } from '@agent-local/vectorizer';
import { TOOLS, findTool, type ToolDeps } from './tools/registry.js';

async function buildDeps(config: MemoMcpConfig): Promise<{ deps: ToolDeps; close: () => Promise<void> }> {
  const { repository, store } = wire(config);
  // pg needs its table/extension before first use; the file backend creates dirs lazily
  if (store instanceof PgVectorStore) {
    await store.ensureSchema();
  }
  if (config.embedProvider === 'local') {
    process.stderr.write(
      'memomcp: WARN embed-provider=local is a hashed bag-of-words — it cannot do paraphrase recall. ' +
      'Use --embed-provider voyage (or openai) for real memory recall.\n',
    );
  }
  const deps: ToolDeps = { repository, defaultCollection: config.defaultCollection };
  return { deps, close: () => store.close() };
}

async function serve(overrides: CliOverrides): Promise<void> {
  const config = loadConfig(overrides);
  const { deps, close } = await buildDeps(config);

  process.stderr.write(
    `memomcp: serving stdio MCP — backend=${config.backend} ` +
    `collection=${config.defaultCollection} ` +
    `baseDir=${config.baseDir} ` +
    `embed=${config.embedProvider}-${config.embedDim}\n`,
  );

  const toolServer = new McpToolServer<ToolDeps>({
    name: 'memomcp',
    version: '0.1.0',
    tools: TOOLS,
    deps,
    onShutdown: async () => {
      try { await close(); } catch { /* best-effort release */ }
    },
  });
  await toolServer.start();
}

async function probe(overrides: CliOverrides, toolName: string, argsJson: string | undefined): Promise<void> {
  const config = loadConfig(overrides);
  const tool = findTool(toolName);
  if (!tool) {
    process.stderr.write(`unknown tool: ${toolName}\n`);
    process.stderr.write(`available tools: ${TOOLS.map((t) => t.name).join(', ')}\n`);
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
  const { deps, close } = await buildDeps(config);
  try {
    const text = await tool.handler(parsedArgs, deps);
    process.stdout.write(text + '\n');
  } finally {
    await close();
  }
}

function listToolsCommand(): void {
  for (const t of TOOLS) {
    process.stdout.write(`${t.name}\n  ${t.description}\n`);
    const props = t.inputSchema as { properties?: Record<string, { type?: string; description?: string }>; required?: string[] };
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
  .name('memomcp')
  .description('Model Context Protocol server exposing agent memory (remember/recall) over the shared vector store.')
  .option('-c, --config <path>', 'path to memomcp.config.json (defaults to ./memomcp.config.json in cwd)')
  .addOption(new Option('-b, --backend <backend>', 'storage backend').choices(['pg', 'file']).default('file'))
  .addOption(new Option('--embed-provider <provider>', 'embedding model provider').choices(['local', 'voyage', 'openai']).default('voyage'))
  .option('--embed-dim <n>', 'embedding dimensionality (must match the stored memories)', (v) => parseDim(v), 1024)
  .option('--collection <id>', 'default collection id when a call omits `collection`', 'default')
  .option('--base-dir <path>', 'file-backend root holding memories/<collection>/records.jsonl')
  .option('--pg-dsn <dsn>', 'Postgres connection string (overrides connectionString from the config file). Prefer this for secrets — pass it via the launching tool, do not commit.');

interface RawOpts {
  config?: string;
  backend: Backend;
  embedProvider: EmbedProvider;
  embedDim: number;
  collection: string;
  baseDir?: string;
  pgDsn?: string;
}

function readOverrides(): CliOverrides {
  const opts = program.opts<RawOpts>();
  const overrides: CliOverrides = {
    backend: opts.backend,
    embedProvider: opts.embedProvider,
    embedDim: opts.embedDim,
    defaultCollection: opts.collection,
  };
  if (opts.config !== undefined) overrides.configPath = opts.config;
  if (opts.baseDir !== undefined) overrides.baseDir = opts.baseDir;
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
  .action(() => {
    listToolsCommand();
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  const e = err as { message?: string; code?: string };
  const msg = e?.message || e?.code || (typeof err === 'string' ? err : '') || 'unknown error';
  process.stderr.write(`memomcp: ${msg}\n`);
  process.exit(1);
});
