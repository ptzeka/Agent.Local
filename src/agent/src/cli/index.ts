#!/usr/bin/env node
// composition root: boots shared infrastructure, then each run mode builds its own runtime after resolving a session
// interactive: picker → build() → REPL; headless: args.sessionId → build() → single dispatch → exit

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import chalk from "chalk";
import dotenv from "dotenv";

import { AgentRuntime } from "../agent/runtime/agent-runtime.js";
import { Container } from "@agent-local/common";
import { Eventing } from "@agent-local/common/eventing";
import { FileLogger } from "@agent-local/common/filelogger";
import { openDatabase } from "@agent-local/common/db";
import { LOGGER, DB } from "../server/container-tokens.js";
import { resolveAgentDbFile } from "../agent/db-schema.js";
import { loadAgentSettings } from "../server/appsettings.js";
import type { AgentRuntimeDeps } from "../agent/runtime/types.js";
import type { RunnerEvent } from "../agent/runners/runner-events.js";
import { buildRuntime as buildRuntimeRef } from "../agent/runtime/build-runtime.js";
import { findProjectRoot, moduleDir, resolveSandboxRoot, resolveSessionsDir } from "../paths.js";
import { parseArgs } from "./args.js";
import { bannerSessionOf, runRepl } from "./repl.js";
import { formatEvent, formatSubSessionNotification, renderSession } from "./render.js";
import { pickSession } from "./session-picker.js";

// exit codes for the headless single-run path
const EXIT_SATISFIED = 0;
const EXIT_ERROR = 1;
const EXIT_CAPPED = 2;
const EXIT_FAILED = 3;
// the run ended on a clarification question with no work done — non-zero so headless callers don't read it as success
const EXIT_AWAITING_INPUT = 4;

// shared infrastructure from bootstrap(); session setup is per run mode, not here
interface Bootstrap {
  projectRoot: string;
  sandboxRoot: string;
  sessionsDir: string;
  configPath: string;
  mcpConfigPath: string;
  // the one startup container: holds the process singletons (logger; the agent.sqlite handle opened once here,
  // schema owned by `db init`). the CLI has no request scope, so the container IS the bootstrap singleton store
  // — buildRuntime reads logger/db off it, the same handles the agent server resolves through req.container.
  container: Container;
  // process-level cancellation root every runtime chains under
  rootSignal: AbortSignal;
  // hands the built runtime to the signal handlers, which exist before it does
  registerRuntime: (runtime: AgentRuntime) => void;
  shutdown: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// MAIN - EntryPoint
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  process.env.LOG_LEVEL = "debug";
  const boot = await bootstrap();
  const logger = boot.container.get(LOGGER);
  logger.debug("********** application start **********", { mode: args.run !== undefined ? "headless" : "interactive" });

  if (args.run !== undefined) {
    const code = await runHeadless(boot, args.run, args.sessionId);
    await boot.shutdown();
    logger.debug("********** application end **********", { code });
    process.exit(code);
  }

  try {
    await runInteractive(boot);
  } finally {
    await boot.shutdown();
    logger.debug("application end", {});
  }
}

// bootstrap args
async function bootstrap(): Promise<Bootstrap> {
  dotenv.config();

  const projectRoot = findProjectRoot(moduleDir(import.meta.url));

  const sandboxRoot = resolveSandboxRoot(projectRoot);
  fs.mkdirSync(sandboxRoot, { recursive: true });

  const sessionsDir = resolveSessionsDir(projectRoot);

  const mcpConfigPath = path.join(projectRoot, "mcp.json");
  const configPath = path.join(projectRoot, "models.json");

  // open the agent DB connection at startup; `db init` owns the schema, so this only opens (never reconciles).
  // the file comes from the agent's appsettings (db.file), overridable by AGENT_DB_FILE for ops
  const db = openDatabase(resolveAgentDbFile(loadAgentSettings().db?.file));

  // runtimes are built later per run mode, so the handlers hold a slot the run mode fills via registerRuntime
  const root = new AbortController();
  const logger = new FileLogger();
  // register the process singletons into the one container; buildRuntime resolves logger/db from it
  const container = new Container();
  container.set(LOGGER, logger);
  container.set(DB, db);
  let activeRuntime: AgentRuntime | null = null;
  const registerRuntime = (runtime: AgentRuntime): void => {
    activeRuntime = runtime;
  };

  const shutdown = async (): Promise<void> => {
    // runtime first: its sweep suppresses child report-backs; aborting root first would race that sweep
    try {
      await activeRuntime?.shutdown({ mode: "abort", timeoutMs: 5_000 });
    } catch {
      // teardown must keep unwinding
    }
    // backstop for anything not parented under the runtime
    root.abort("process-shutdown");
    // close after the runtime drained, so no in-flight session/transcript flush races the close
    try {
      db.close();
    } catch {
      // teardown must keep unwinding
    }
  };

  process.on("SIGINT", () => {
    void shutdown().finally(() => process.exit(EXIT_ERROR));
  });
  process.on("SIGTERM", () => {
    void shutdown().finally(() => process.exit(EXIT_ERROR));
  });

  return {
    projectRoot,
    sandboxRoot,
    sessionsDir,
    mcpConfigPath,
    configPath,
    container,
    rootSignal: root.signal,
    registerRuntime,
    shutdown,
  };
}


// ---------------------------------------------------------------------------
// Start RunTime
// ---------------------------------------------------------------------------


// streamOutput defaults off; only the interactive REPL (a live incremental renderer) opts in
function buildRuntime(
  boot: Bootstrap,
  eventing: Eventing,
  sessionId?: string,
  streamOutput = false
): AgentRuntime {
  const { projectRoot, sandboxRoot, sessionsDir, mcpConfigPath, configPath } = boot;
  const db = boot.container.get(DB);
  const token = process.env.AGENT_API_TOKEN;
  const deps: AgentRuntimeDeps = {
    mcpConfigPath,
    configPath,
    sessionsDir,
    db,
    workspaceRoot: projectRoot,
    sandboxRoot,
    logger: boot.container.get(LOGGER),
    credentials: token ? { token } : {},
    orchestratorRole: "orchestrator",
    parentSignal: boot.rootSignal,
    // host's bus: the runtime chains its own under this, so runtime events bubble up to the CLI
    eventing,
    streamOutput,
  };
  return buildRuntimeRef(deps, sessionId);
}

// interactive e.g. user request/response
async function runInteractive(boot: Bootstrap): Promise<void> {
  const { projectRoot, sandboxRoot, configPath } = boot;

  const saved = await AgentRuntime.listSavedSessions(boot.container.get(DB));
  const choice = await pickSession(saved);

  // no out-of-band status line: the REPL is the sole TTY writer, so a raw write would land in its pinned-prompt region
  const eventing = new Eventing();

  const runtime = await buildRuntime(boot, eventing, choice.kind === "resume" ? choice.sessionId : undefined, true).build();
  boot.registerRuntime(runtime);

  // surface sub-sessions that report back out-of-band between turns
  const unsubscribe = runtime.onSubSessionEvent((notification) =>
    process.stdout.write(formatSubSessionNotification(notification))
  );
  try {
    await runRepl({
      workspaceRoot: projectRoot,
      sandboxRoot,
      configPath,
      runtime,
      resumed: choice.kind === "resume",
    });
  } finally {
    unsubscribe();
    // bounded drain (escalates to abort on expiry) so a hung child can't wedge the process
    await runtime.shutdown({ mode: "drain", timeoutMs: 30_000 });
  }
}

// headless: a single run, then exit
async function runHeadless(
  boot: Bootstrap,
  input: string,
  sessionId?: string
): Promise<number> {
  try {
    // progress goes to stderr here so stdout stays reserved for the final answer
    const eventing = new Eventing();
    eventing.subscribe("runtime-status", (e) =>
      process.stderr.write(chalk.gray(`[runtime] ${String(e.payload.status)}\n`))
    );

    const runtime = await buildRuntime(boot, eventing, sessionId).build();
    boot.registerRuntime(runtime);

    const unsubscribe = runtime.onSubSessionEvent((notification) =>
    process.stdout.write(formatSubSessionNotification(notification))
  );

    process.stderr.write(chalk.gray(`[session ${runtime.getSession().sessionId}]\n`));

    // map the bus's {type,payload} to the renderer's {type,data} at this boundary
    const unsubEvents = runtime.getEvents().subscribe((event) =>
      process.stdout.write(formatEvent({ type: event.type, data: event.payload } as RunnerEvent))
    );

    try {
      // the process root is the turn's cutoff, so SIGINT/SIGTERM cut the in-flight model/tool/sub-run awaits
      const result = await runtime.dispatchAsync(input, { signal: boot.rootSignal });
      await runtime.awaitSubSessions();
      process.stdout.write(result.finalMessage.content + "\n");
      // to stderr so stdout stays reserved for the final answer
      renderSession(bannerSessionOf(runtime, sessionId !== undefined), (text) =>
        void process.stderr.write(text)
      );
      return result.outcome === "satisfied"
        ? EXIT_SATISFIED
        : result.outcome === "awaiting-input"
          ? EXIT_AWAITING_INPUT
          : result.outcome === "failed"
            ? EXIT_FAILED
            : EXIT_CAPPED;
    } finally {
      unsubEvents();
      unsubscribe();
      // Cancels the runtime scope so token-holding resources release before exit.
      await runtime.shutdown({ mode: "drain", timeoutMs: 30_000 });
    }
  } catch (err) {
    process.stderr.write(chalk.red(`\n[error] runHeadless: ${(err as Error).message}\n`));
    return EXIT_ERROR;
  }
}

// ---------------------------------------------------------------------------
// BEGIN
// ---------------------------------------------------------------------------


main().catch((err) => {
  process.stderr.write(chalk.red(`\n[fatal] ${(err as Error).stack ?? err}\n`));
  process.exit(EXIT_ERROR);
});
