#!/usr/bin/env node
/**
 * CLI entry point — the composition root.
 *
 * Boots the shared infrastructure in order:
 *   1. Environment + workspace settings.
 *   2. The MCP tool client (spawns the tools server child process).
 *   3. The model registry (instantiates every provider declared in models.json).
 *
 * Session setup is deferred to each run mode via AgentRuntime's middleware
 * pipeline. Both modes share the same infrastructure but build their own
 * runtime after resolving the session:
 *
 *   Interactive: session picker → AgentRuntime.build() → REPL
 *   Headless:    args.sessionId → AgentRuntime.build() → single dispatch → exit
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import url from "node:url";

import chalk from "chalk";
import dotenv from "dotenv";

import { McpToolClient } from "../agent/mcp-client.js";
import { ModelRegistry } from "../agent/model-registry.js";
import { AgentRuntime } from "../agent/runtime/agent-runtime.js";
import { AnonymousMiddleware } from "../agent/runtime/middleware/anonymous.js";
import { IdentityMiddleware } from "../agent/runtime/middleware/identity.js";
import { InputInboxMiddleware } from "../agent/runtime/middleware/input-inbox.js";
import { OrchestratorMiddleware } from "../agent/runtime/middleware/orchestrator.js";
import { SessionManagerMiddleware } from "../agent/runtime/middleware/session-manager.js";
import { SessionMiddleware } from "../agent/runtime/middleware/session.js";
import { StoreMiddleware } from "../agent/runtime/middleware/store.js";
import { WorkspaceRegistryMiddleware } from "../agent/runtime/middleware/workspace-registry.js";
import { parseArgs } from "./args.js";
import { runRepl } from "./repl.js";
import { renderEvent, renderSubSessionNotification } from "./render.js";
import { pickSession } from "./session-picker.js";

/** Exit codes for the headless single-run path. */
const EXIT_SATISFIED = 0;
const EXIT_ERROR = 1;
const EXIT_CAPPED = 2;

/** Shared infrastructure produced by bootstrap(). Session setup is NOT here —
 *  each run mode builds its own AgentRuntime after choosing a session. */
interface Bootstrap {
  projectRoot: string;
  sandboxRoot: string;
  sessionsDir: string;
  registry: ModelRegistry;
  tools: McpToolClient;
  shutdown: () => Promise<void>;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const boot = await bootstrap();

  if (args.run !== undefined) {
    const code = await runHeadless(boot, args.run, args.sessionId);
    await boot.shutdown();
    process.exit(code);
  }

  try {
    await runInteractive(boot);
  } finally {
    await boot.shutdown();
  }
}

/**
 * Bring up the shared infrastructure (tools + model registry) and return it
 * with a teardown callback. Session creation happens per run-mode via
 * AgentRuntime so the session picker and headless session-id argument both
 * land in the same place — the pipeline.
 */
async function bootstrap(): Promise<Bootstrap> {
  dotenv.config();

  const projectRoot = findProjectRoot();

  const sandboxRoot = path.resolve(
    process.env.AGENT_WORKSPACE ?? path.join(projectRoot, "src", "agent", "workspace")
  );
  fs.mkdirSync(sandboxRoot, { recursive: true });

  const sessionsDir = path.resolve(
    process.env.AGENT_SESSIONS_DIR ?? path.join(projectRoot, "src", "agent", "sessions")
  );

  const mcpConfigPath = path.join(projectRoot, "mcp.json");
  const modelsConfigPath = path.join(projectRoot, "models.json");

  const tools = await McpToolClient.connect(mcpConfigPath, sandboxRoot);
  const registry = await ModelRegistry.load(modelsConfigPath);

  const shutdown = async (): Promise<void> => {
    await tools.shutdown();
  };

  process.on("SIGINT", () => {
    void shutdown().finally(() => process.exit(EXIT_ERROR));
  });
  process.on("SIGTERM", () => {
    void shutdown().finally(() => process.exit(EXIT_ERROR));
  });

  return { projectRoot, sandboxRoot, sessionsDir, registry, tools, shutdown };
}

/**
 * Build an AgentRuntime with the standard pipeline. Every subsystem the runtime
 * owns is produced by a step here — build() constructs nothing itself:
 *   StoreMiddleware             — open the on-disk session store
 *   WorkspaceRegistryMiddleware — create the workspace → root/context map
 *   IdentityMiddleware          — decode JWT from AGENT_API_TOKEN if present
 *   AnonymousMiddleware         — fall back to anonymous when no creds resolve
 *   SessionMiddleware           — open or resume the session, stamp session.user
 *   OrchestratorMiddleware      — build the stateless turn orchestrator
 *   InputInboxMiddleware        — create the external input injection seam
 *   SessionManagerMiddleware    — build the sub-session manager
 */
function buildRuntime(
  boot: Bootstrap,
  sessionId?: string
): AgentRuntime {
  const { projectRoot, sessionsDir, registry, tools } = boot;
  const token = process.env.AGENT_API_TOKEN;
  return new AgentRuntime({
    registry,
    tools,
    sessionsDir,
    workspaceRoot: projectRoot,
    credentials: token ? { token } : {},
  })
  .add(new StoreMiddleware())
  .add(new WorkspaceRegistryMiddleware())
  .add(new IdentityMiddleware())
  .add(new AnonymousMiddleware())
  .add(new SessionMiddleware({ sessionId }))
  .add(new OrchestratorMiddleware())
  .add(new InputInboxMiddleware())
  .add(new SessionManagerMiddleware());
}

/**
 * Interactive mode. Lists saved sessions so the user can resume or start
 * fresh, then builds the runtime through the pipeline and hands off to
 * the REPL.
 */
async function runInteractive(boot: Bootstrap): Promise<void> {
  const { projectRoot, sandboxRoot, sessionsDir, registry, tools } = boot;

  const saved = await AgentRuntime.listSavedSessions(sessionsDir);
  const choice = await pickSession(saved);

  const runtime = await buildRuntime(boot, choice.kind === "resume" ? choice.sessionId : undefined).build();

  // Drain any sub-sessions that outlive a turn before the REPL exits.
  const unsubscribe = runtime.onSubSessionEvent(renderSubSessionNotification);
  try {
    await runRepl({
      workspaceRoot: projectRoot,
      sandboxRoot,
      registry,
      tools,
      runtime,
      resumed: choice.kind === "resume",
    });
  } finally {
    unsubscribe();
    await runtime.awaitAllSubSessions();
  }
}

/**
 * Headless single run: build a runtime for the given (or fresh) session,
 * dispatch ONE turn, drain sub-tasks, persist, print the answer, and return
 * the process exit code.
 *
 * Progress goes to stderr so stdout carries only the final answer.
 */
async function runHeadless(
  boot: Bootstrap,
  input: string,
  sessionId?: string
): Promise<number> {
  try {
    const runtime = await buildRuntime(boot, sessionId).build();

    const unsubscribe = runtime.onSubSessionEvent(renderSubSessionNotification);

    process.stderr.write(chalk.gray(`[session ${runtime.getSession().sessionId}]\n`));

    try {
      const result = await runtime.dispatchAsync(input, { onEvent: renderEvent });
      await runtime.awaitSubSessions();
      process.stdout.write(result.finalMessage.content + "\n");
      return result.outcome === "satisfied" ? EXIT_SATISFIED : EXIT_CAPPED;
    } finally {
      unsubscribe();
    }
  } catch (err) {
    process.stderr.write(chalk.red(`\n[error] ${(err as Error).message}\n`));
    return EXIT_ERROR;
  }
}

function findProjectRoot(): string {
  const here = url.fileURLToPath(new URL(".", import.meta.url));
  let cursor = path.resolve(here);
  while (true) {
    if (fs.existsSync(path.join(cursor, "mcp.json"))) return cursor;
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      throw new Error(
        `Could not locate mcp.json walking up from ${here}. Make sure the agent is launched from inside the workspace.`
      );
    }
    cursor = parent;
  }
}

main().catch((err) => {
  process.stderr.write(chalk.red(`\n[fatal] ${(err as Error).stack ?? err}\n`));
  process.exit(EXIT_ERROR);
});
