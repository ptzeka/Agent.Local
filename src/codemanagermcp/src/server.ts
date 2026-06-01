#!/usr/bin/env node
import { Command } from 'commander';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { config, serverDir } from './config.js';
import { resolveToken } from './azuredevops.js';
import { TOOLS, findTool, type ToolDeps } from './tools/registry.js';

async function serve(): Promise<void> {
  const adoToken = resolveToken(config.azureDevOps.apiKeyFile, serverDir);

  process.stderr.write(
    `codemanagermcp: serving stdio MCP\n` +
    `  repositoryPath:  ${config.repositoryPath}\n` +
    `  mainBranch:      ${config.mainBranch}\n` +
    `  branchPrefix:    ${config.branchPrefix}\n` +
    `  repositories:    ${Object.keys(config.azureDevOps.repositories).join(', ')}\n` +
    `  deployPipeline:  #${config.azureDevOps.pipelines.deployPipelineId}\n` +
    `  ciPipeline:      #${config.azureDevOps.pipelines.ciPipelineId}\n` +
    (config.azureDevOps.pipelines.deletePipelineId
      ? `  deletePipeline:  #${config.azureDevOps.pipelines.deletePipelineId}\n`
      : `  deletePipeline:  (none configured)\n`) +
    `  ciTimeout:       ${config.azureDevOps.pipelines.ciTimeoutMinutes ?? 15} min\n` +
    `  token:           ${adoToken ? 'resolved' : 'MISSING'}\n` +
    `  serverDir:       ${serverDir}\n`,
  );

  const deps: ToolDeps = { config, serverDir, adoToken };

  const mcp = new McpServer({ name: 'codemanagermcp', version: '0.1.0' });

  for (const tool of TOOLS) {
    mcp.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputShape,
      },
      async (input: unknown) => {
        try {
          const text = await tool.handler(input as never, deps);
          return { content: [{ type: 'text' as const, text }] };
        } catch (err) {
          return {
            content: [{ type: 'text' as const, text: `${tool.name} failed: ${(err as Error).message}` }],
            isError: true,
          };
        }
      },
    );
  }

  const transport = new StdioServerTransport();
  await mcp.connect(transport);

  const shutdown = async (): Promise<void> => { process.exit(0); };
  process.on('SIGINT',  () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });
}

async function probe(toolName: string, argsJson: string | undefined): Promise<void> {
  const adoToken = resolveToken(config.azureDevOps.apiKeyFile, serverDir);
  const deps: ToolDeps = { config, serverDir, adoToken };

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

  const text = await tool.handler(parsedArgs as never, deps);
  process.stdout.write(text + '\n');
}

async function listToolsCommand(): Promise<void> {
  for (const t of TOOLS) {
    process.stdout.write(`${t.name}\n  ${t.description}\n`);
    for (const [name, schema] of Object.entries(t.inputShape)) {
      const desc = schema.description ?? '';
      const optional = schema.isOptional() ? '' : ' (required)';
      process.stdout.write(`  - ${name}${optional}${desc ? ` — ${desc}` : ''}\n`);
    }
    process.stdout.write('\n');
  }
}

const program = new Command();

program
  .name('codemanagermcp')
  .description(
    'MCP server that orchestrates workflow verbs ' +
    '(start_feature, push_changes, accept_changes, abandon_changes) ' +
    'backed by Azure DevOps Repos and Pipelines.',
  );

program
  .command('serve', { isDefault: true })
  .description('Start the stdio MCP server (default).')
  .action(async () => { await serve(); });

program
  .command('probe <tool> [argsJson]')
  .description('Invoke a single tool from the command line without an MCP client. One-shot, for debugging.')
  .action(async (toolName: string, argsJson?: string) => {
    await probe(toolName, argsJson);
  });

program
  .command('tools')
  .description('List available tools and their input schemas.')
  .action(async () => { await listToolsCommand(); });

program.parseAsync(process.argv).catch((err: unknown) => {
  const e   = err as { message?: string; code?: string };
  const msg = e?.message ?? e?.code ?? (typeof err === 'string' ? err : '') ?? 'unknown error';
  process.stderr.write(`codemanagermcp: ${msg}\n`);
  process.exit(1);
});
