#!/usr/bin/env node
/**
 * CLI entry point.
 *
 * Boots three subsystems in order:
 *   1. Environment + workspace settings.
 *   2. The MCP tool client (spawns the tools server child process).
 *   3. The model registry (instantiates every provider declared in models.json).
 *
 * Then it hands control to the REPL. On exit, it tears everything down.
 */

import path from "node:path";
import process from "node:process";
import url from "node:url";

import chalk from "chalk";
import dotenv from "dotenv";

import { McpToolClient } from "../agent/mcp-client.js";
import { ModelRegistry } from "../agent/model-registry.js";
import { loadProjectContext } from "../agent/context-loader.js";
import { runRepl } from "./repl.js";

async function main(): Promise<void> {
  // Load .env if present. Silently no-op if missing.
  dotenv.config();

  const projectRoot = findProjectRoot();
  const workspaceRoot = path.resolve(process.env.AGENT_WORKSPACE ?? projectRoot);

  const mcpConfigPath = path.join(projectRoot, "mcp.json");
  const modelsConfigPath = path.join(projectRoot, "models.json");

  const tools = await McpToolClient.connect(mcpConfigPath, workspaceRoot);
  const registry = await ModelRegistry.load(modelsConfigPath);
  const projectContext = await loadProjectContext(workspaceRoot);

  // Wire shutdown so child MCP servers don't outlive us.
  const shutdown = async (): Promise<void> => {
    await tools.shutdown();
  };
  process.on("SIGINT", () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void shutdown().finally(() => process.exit(0));
  });

  try {
    await runRepl({ workspaceRoot, registry, tools, projectContext });
  } finally {
    await shutdown();
  }
}

/**
 * Walk up from this file's location until we find a directory containing
 * mcp.json. This lets `npm start` work whether the user runs from the
 * project root or from a subdirectory.
 */
function findProjectRoot(): string {
  const here = url.fileURLToPath(new URL(".", import.meta.url));
  // dist/cli → up two levels lands at the project root in built mode.
  // src/cli  → up two levels lands at the project root in dev (tsx) mode.
  return path.resolve(here, "..", "..");
}

main().catch((err) => {
  process.stderr.write(chalk.red(`\n[fatal] ${(err as Error).stack ?? err}\n`));
  process.exit(1);
});
