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

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import url from "node:url";

import chalk from "chalk";
import dotenv from "dotenv";

import { McpToolClient } from "../agent/mcp-client.js";
import { ModelRegistry } from "../agent/model-registry.js";
import { Initializer } from "../agent/initializer.js";
import { runRepl } from "./repl.js";

async function main(): Promise<void> {
  // Load .env if present. Silently no-op if missing.
  dotenv.config();

  const projectRoot = findProjectRoot();

  // The fs tool sandbox. Every fsmcp operation — read_file, write_file,
  // edit_file, list_dir, glob, grep — is confined to this directory by the
  // workspace guard, so all generated output lands here and nowhere else.
  // Defaults to src/agent/workspace under the project root; override with
  // AGENT_WORKSPACE. (codemcp resolves its repo from process.cwd() and is
  // unaffected, so repo-wide code search still spans the whole project.)
  const sandboxRoot = path.resolve(
    process.env.AGENT_WORKSPACE ?? path.join(projectRoot, "src", "agent", "workspace")
  );
  // Ensure the sandbox exists before fsmcp tries to access it on startup.
  fs.mkdirSync(sandboxRoot, { recursive: true });

  const mcpConfigPath = path.join(projectRoot, "mcp.json");
  const modelsConfigPath = path.join(projectRoot, "models.json");

  const tools = await McpToolClient.connect(mcpConfigPath, sandboxRoot);
  const registry = await ModelRegistry.load(modelsConfigPath);

  // The Initializer is the stateful session owner. It builds the file-backed
  // session store and drives the stateless orchestrator. Sessions persist
  // under .sessions (override with AGENT_SESSIONS_DIR).
  const sessionsDir = path.resolve(
    process.env.AGENT_SESSIONS_DIR ?? path.join(projectRoot, ".sessions")
  );
  const initializer = Initializer.create({ registry, tools, sessionsDir });

  // New session every run for now. Project context lives at the project root
  // (src/context/agentcontext.md), so the workspace root is the project root,
  // not the fs sandbox.
  const mainSession = await initializer.openSession({ workspaceRoot: projectRoot });
  const projectContext = initializer.getWorkspaceContext(mainSession.sessionId);

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
    await runRepl({
      workspaceRoot: projectRoot,
      sandboxRoot,
      registry,
      tools,
      initializer,
      sessionId: mainSession.sessionId,
      projectContext,
    });
  } finally {
    await shutdown();
  }
}

/**
 * Walk up from this file's location until we find a directory containing
 * mcp.json. This lets `npm start` work whether the user runs from the
 * project root or from a subdirectory, and survives the package being
 * nested deeper under src/agent/{dist,src}/cli.
 */
function findProjectRoot(): string {
  const here = url.fileURLToPath(new URL(".", import.meta.url));
  let cursor = path.resolve(here);
  while (true) {
    if (fs.existsSync(path.join(cursor, "mcp.json"))) return cursor;
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      throw new Error(
        `Could not locate mcp.json walking up from ${here}. Make sure the agent is launched from inside the workspace.`,
      );
    }
    cursor = parent;
  }
}

main().catch((err) => {
  process.stderr.write(chalk.red(`\n[fatal] ${(err as Error).stack ?? err}\n`));
  process.exit(1);
});
