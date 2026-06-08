#!/usr/bin/env node
/**
 * CLI entry point — the composition root.
 *
 * Boots the subsystems in order:
 *   1. Environment + workspace settings.
 *   2. The MCP tool client (spawns the tools server child process).
 *   3. The model registry (instantiates every provider declared in models.json).
 *   4. The Initializer (via `Initializer.create`) — the stateful session owner.
 *      It wires the rest internally: the file-backed SessionStore, the
 *      WorkspaceRegistry, a single stateless Orchestrator, and the
 *      SessionManager that owns sub-sessions. See the ownership tree on the
 *      `Initializer` class.
 *
 * Two run modes share that bootstrap:
 *   - Interactive (default): the session picker resumes a saved top-level
 *     session or opens a fresh one, and control passes to the REPL.
 *   - Headless single run (`--run "<input>" [--session <id>]`): resume or open a
 *     session, dispatch ONE turn to completion (evaluator satisfied, or the
 *     orchestrator iteration cap = the "all fails" bound), drain any sub-tasks,
 *     persist, print the answer, and exit with a status code.
 *
 * On exit, either path tears everything down.
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
import { parseArgs } from "./args.js";
import { runRepl } from "./repl.js";
import { renderEvent, renderSubSessionNotification } from "./render.js";
import { pickSession } from "./session-picker.js";

/** Exit codes for the headless single-run path. 0 = the evaluator was
 *  satisfied; non-zero = the run did not complete cleanly. */
const EXIT_SATISFIED = 0;
const EXIT_ERROR = 1; // the run threw
const EXIT_CAPPED = 2; // hit the orchestrator iteration cap without satisfying

/** The bootstrapped subsystems plus a teardown both run modes share. */
interface Bootstrap {
  projectRoot: string;
  sandboxRoot: string;
  registry: ModelRegistry;
  tools: McpToolClient;
  initializer: Initializer;
  shutdown: (options?: { drain?: boolean }) => Promise<void>;
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
 * Bring up the shared subsystems and return them with a teardown. Both the
 * interactive REPL and the headless single run start here, so the wiring lives
 * in exactly one place — the seam any future entry point (an HTTP server, a
 * batch runner) hangs off of.
 */
async function bootstrap(): Promise<Bootstrap> {
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
  // under src/agent/sessions (override with AGENT_SESSIONS_DIR).
  const sessionsDir = path.resolve(
    process.env.AGENT_SESSIONS_DIR ?? path.join(projectRoot, "src", "agent", "sessions")
  );
  const initializer = Initializer.create({ registry, tools, sessionsDir });

  // Wire shutdown so child MCP servers don't outlive us. Idempotent enough for
  // both the signal handlers and the normal-exit path to call it.
  //
  // On a normal exit we first drain any background sub-sessions still in flight,
  // so a task the REPL fired-and-forgot isn't killed mid-run when MCP tears down.
  // Signal-driven teardown skips the drain (`drain: false`): Ctrl+C is an
  // immediate escape hatch and must not block on outstanding work.
  const shutdown = async (options: { drain?: boolean } = {}): Promise<void> => {
    if (options.drain ?? true) {
      await initializer.awaitAllSubSessions();
    }
    await tools.shutdown();
  };
  process.on("SIGINT", () => {
    void shutdown({ drain: false }).finally(() => process.exit(EXIT_ERROR));
  });
  process.on("SIGTERM", () => {
    void shutdown({ drain: false }).finally(() => process.exit(EXIT_ERROR));
  });

  return { projectRoot, sandboxRoot, registry, tools, initializer, shutdown };
}

/**
 * Interactive mode. Always force a session choice at startup — resume an
 * existing one or bootstrap a new one — rather than silently minting a
 * just-in-time session. With none saved the picker still shows its lone
 * "create new" row. Project context lives at the project root
 * (src/context/agentcontext.md), so the workspace root is the project root,
 * not the fs sandbox.
 */
async function runInteractive(boot: Bootstrap): Promise<void> {
  const { projectRoot, sandboxRoot, registry, tools, initializer } = boot;

  const saved = await initializer.listSavedSessions();
  const choice = await pickSession(saved);
  const mainSession =
    choice.kind === "resume"
      ? await initializer.resumeSession({ sessionId: choice.sessionId, workspaceRoot: projectRoot })
      : await initializer.openSession({ workspaceRoot: projectRoot });
  const projectContext = initializer.getWorkspaceContext(mainSession.sessionId);

  await runRepl({
    workspaceRoot: projectRoot,
    sandboxRoot,
    registry,
    tools,
    initializer,
    sessionId: mainSession.sessionId,
    resumed: choice.kind === "resume",
    projectContext,
  });
}

/**
 * Headless single run: drive ONE turn to completion against a resumed or fresh
 * session, then exit. The orchestrator loops internally until the evaluator is
 * satisfied or it caps out — there is no separate wall-clock timeout; the cap
 * is the "tried too many times / all fails" bound and surfaces as a non-zero
 * exit. Before returning, every sub-session this run spawned is drained, so no
 * detached sub-task is abandoned mid-flight (the interactive path lets those
 * report back asynchronously; a one-shot process cannot).
 *
 * Progress is rendered to stderr so stdout carries only the final answer,
 * keeping the output pipe-friendly. Returns the process exit code.
 */
async function runHeadless(
  boot: Bootstrap,
  input: string,
  sessionId?: string
): Promise<number> {
  const { projectRoot, initializer } = boot;

  // Surface sub-session completions as they settle, same as the REPL does.
  const unsubscribe = initializer.onSubSessionEvent(renderSubSessionNotification);

  try {
    const session = sessionId
      ? await initializer.resumeSession({ sessionId, workspaceRoot: projectRoot })
      : await initializer.openSession({ workspaceRoot: projectRoot });

    // Echo the session id (to stderr) so the caller can resume it later.
    process.stderr.write(chalk.gray(`[session ${session.sessionId}]\n`));

    const result = await initializer.dispatch(session.sessionId, input, { onEvent: renderEvent });

    // Block until any detached children settle and persist themselves before we
    // tear down — this is the synchronous drain a one-shot run requires.
    await initializer.awaitSubSessions(session.sessionId);

    // stdout = the answer, and nothing else.
    process.stdout.write(result.finalMessage.content + "\n");

    return result.outcome === "satisfied" ? EXIT_SATISFIED : EXIT_CAPPED;
  } catch (err) {
    process.stderr.write(chalk.red(`\n[error] ${(err as Error).message}\n`));
    return EXIT_ERROR;
  } finally {
    unsubscribe();
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
  process.exit(EXIT_ERROR);
});
