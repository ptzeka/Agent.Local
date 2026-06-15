#!/usr/bin/env node
import { Command, Option } from 'commander';
import { loadConfig, type Backend, type CliOverrides } from './config.js';
import { MigrationRunner } from './publisher/migrate.js';
import { publish } from './publisher/publish.js';
import { VectorService, type EmbedProvider } from '@agent-local/vectorizer';
import { wireWriter } from './wiring.js';

const program = new Command();

program
  .name('codeindex')
  .description(
    'Chunk, embed, and publish a repository to PostgreSQL/pgvector for codemcp. ' +
    'The directory being indexed is process.cwd() unless you pass --root <path> ' +
    '(path is resolved relative to cwd when relative).',
  )
  .option(
    '-r, --root <path>',
    'directory to index (default: cwd). Config file defaults to <root>/codeindex.config.json when --config is omitted.',
  )
  .option(
    '-c, --config <path>',
    'path to codeindex.config.json (resolved against cwd; default file is <root>/codeindex.config.json when omitted)',
  )
  .addOption(new Option('-b, --backend <backend>', 'storage backend').choices(['pg', 'file']).default('pg'))
  .option('--branch <branch>', 'branch name recorded on the commit row', 'main')
  .option('--repository <name>', 'override repository id stored on the commit row; when omitted, uses origin URL (owner/repo) if set, else the resolved absolute path of the index root')
  .addOption(new Option('--embed-provider <provider>', 'embedding model provider').choices(['local', 'voyage', 'openai']).default('local'))
  .option('--embed-dim <n>', 'embedding dimensionality (must match the chunks.embedding column for pg backend)', (v) => parseDim(v), 768);

function parseDim(input: string): number {
  const n = Number(input);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new Error(`--embed-dim must be a positive integer (got: ${input})`);
  }
  return n;
}

function readOverrides(): CliOverrides {
  const opts = program.opts<{
    config?: string;
    root?: string;
    backend: Backend;
    branch: string;
    repository?: string;
    embedProvider: EmbedProvider;
    embedDim: number;
  }>();
  const overrides: CliOverrides = {
    backend: opts.backend,
    branch: opts.branch,
    embedProvider: opts.embedProvider,
    embedDim: opts.embedDim,
  };
  if (opts.config !== undefined) overrides.configPath = opts.config;
  if (opts.root !== undefined) overrides.rootDir = opts.root;
  if (opts.repository !== undefined) overrides.repository = opts.repository;
  return overrides;
}

function printContext(config: ReturnType<typeof loadConfig>): void {
  process.stdout.write(`root dir:       ${config.rootDir}\n`);
  process.stdout.write(`backend:        ${config.backend}\n`);
  process.stdout.write(`branch:         ${config.branch}\n`);
  process.stdout.write(`repository:     ${config.repository ?? '(auto-detect)'}\n`);
  process.stdout.write(`embed provider: ${config.embedProvider}\n`);
  process.stdout.write(`embed dim:      ${config.embedDim}\n`);
  if (config.backend === 'file') {
    process.stdout.write(`file dir:       ${config.fileDir}\n`);
  }
}

program
  .command('migrate')
  .description('Apply pending SQL migrations (file backend: seed schema_versions journal).')
  .option('--status', 'show applied / pending migrations without applying anything')
  .action(async (opts: { status?: boolean }) => {
    const config = loadConfig(readOverrides());
    const { factory, repo, supportsSql } = wireWriter(config);
    const runner = new MigrationRunner(factory, repo, { executeSql: supportsSql });
    try {
      printContext(config);
      if (opts.status) {
        const status = await runner.status();
        process.stdout.write(`applied:\n`);
        for (const a of status.applied) process.stdout.write(`  ${a.scriptName}\n`);
        process.stdout.write(`pending:\n`);
        for (const p of status.pending) process.stdout.write(`  ${p.name}\n`);
      } else {
        const { appliedNow } = await runner.run();
        if (appliedNow.length === 0) {
          process.stdout.write(`no pending migrations\n`);
        } else {
          process.stdout.write(`applied now:\n`);
          for (const n of appliedNow) process.stdout.write(`  ${n}\n`);
        }
      }
    } finally {
      await factory.end();
    }
  });

program
  .command('publish')
  .description('Run migrations, then chunk + embed + upsert the current commit.')
  .action(async () => {
    const config = loadConfig(readOverrides());
    const { factory, repo, supportsSql } = wireWriter(config);
    const runner = new MigrationRunner(factory, repo, { executeSql: supportsSql });
    try {
      printContext(config);
      await runner.run();
      const embedder = VectorService.fromProvider(config.embedProvider, config.embedDim);
      const result = await publish({
        config,
        factory,
        repo,
        embedder,
        log: (m) => process.stdout.write(`[codeindex] ${m}\n`),
      });
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    } finally {
      await factory.end();
    }
  });

program
  .command('pack-and-publish')
  .description('Alias for `publish` — both steps are bundled by default.')
  .action(async () => {
    await program.parseAsync([process.argv[0]!, process.argv[1]!, 'publish', ...passThroughGlobals()]);
  });

program
  .command('plan')
  .description('Show what would be indexed (walker output) without touching the backend.')
  .action(async () => {
    const config = loadConfig(readOverrides());
    const { walkRepository } = await import('./indexer/walker.js');
    const files = walkRepository({ rootDir: config.rootDir, excludeGlobs: config.excludeGlobs });
    printContext(config);
    process.stdout.write(`${files.length} files\n`);
    for (const f of files) process.stdout.write(`  ${f.relativePath}\n`);
  });

function passThroughGlobals(): string[] {
  // Used by the pack-and-publish alias so it inherits all top-level flags.
  const opts = program.opts<Record<string, unknown>>();
  const out: string[] = [];
  if (opts.config !== undefined) out.push('--config', String(opts.config));
  if (opts.root !== undefined) out.push('--root', String(opts.root));
  if (opts.backend !== undefined) out.push('--backend', String(opts.backend));
  if (opts.branch !== undefined) out.push('--branch', String(opts.branch));
  if (opts.repository !== undefined) out.push('--repository', String(opts.repository));
  if (opts.embedProvider !== undefined) out.push('--embed-provider', String(opts.embedProvider));
  if (opts.embedDim !== undefined) out.push('--embed-dim', String(opts.embedDim));
  return out;
}

program.parseAsync(process.argv).catch((err: unknown) => {
  const e = err as { message?: string; code?: string };
  const msg = e?.message || e?.code || (typeof err === 'string' ? err : '') || 'unknown error';
  process.stderr.write(`codeindex: ${msg}\n`);
  process.exit(1);
});
