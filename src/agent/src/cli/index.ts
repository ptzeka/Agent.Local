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

import { AgentRuntime } from "../agent/runtime/agent-runtime.js";
import { Eventing } from "../common/eventing.js";
import { FileLogger } from "../common/filelogger.js";
import { ILogger } from "../common/ilogger.js";
import type { AgentRuntimeDeps } from "../agent/runtime/types.js";
import type { RunnerEvent } from "../agent/runners/runner-events.js";
import { buildRuntime as buildRuntimeRef } from "../agent/runtime/build-runtime.js";
import { parseArgs } from "./args.js";
import { bannerSessionOf, runRepl } from "./repl.js";
import { formatEvent, formatSubSessionNotification, renderSession } from "./render.js";
import { pickSession } from "./session-picker.js";

/** Exit codes for the headless single-run path. */
const EXIT_SATISFIED = 0;
const EXIT_ERROR = 1;
const EXIT_CAPPED = 2;
const EXIT_FAILED = 3;

/** Shared infrastructure produced by bootstrap(). Session setup is NOT here —
 *  each run mode builds its own AgentRuntime after choosing a session. */
interface Bootstrap {
  projectRoot: string;
  sandboxRoot: string;
  sessionsDir: string;
  configPath: string;
  mcpConfigPath: string;
  logger: ILogger;
  /** Process-level cancellation root — every runtime chains under it. */
  rootSignal: AbortSignal;
  /** Hand the built runtime to the signal handlers, which exist before it does. */
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
  const logger = boot.logger;
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

  const projectRoot = findProjectRoot();

  const sandboxRoot = path.resolve(
    process.env.AGENT_WORKSPACE ?? path.join(projectRoot, "src", "agent", "workspace")
  );
  fs.mkdirSync(sandboxRoot, { recursive: true });

  const sessionsDir = path.resolve(
    process.env.AGENT_SESSIONS_DIR ?? path.join(projectRoot, "src", "agent", "sessions")
  );

  const mcpConfigPath = path.join(projectRoot, "mcp.json");
  const configPath = path.join(projectRoot, "models.json");

  // Process-level cancellation root. Runtimes are built later (per run mode),
  // so the handlers hold a slot the run mode fills via registerRuntime.
  const root = new AbortController();
  const logger = new FileLogger();
  let activeRuntime: AgentRuntime | null = null;
  const registerRuntime = (runtime: AgentRuntime): void => {
    activeRuntime = runtime;
  };

  const shutdown = async (): Promise<void> => {
    // Runtime first: its sweep suppresses child report-backs before the scope
    // cancel; aborting root first would race that sweep.
    try {
      await activeRuntime?.shutdown({ mode: "abort", timeoutMs: 5_000 });
    } catch {
      /* teardown must keep unwinding */
    }
    // Backstop for anything not parented under the runtime.
    root.abort("process-shutdown");
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
    logger,
    rootSignal: root.signal,
    registerRuntime,
    shutdown,
  };
}


// ---------------------------------------------------------------------------
// Start RunTime
// ---------------------------------------------------------------------------


function buildRuntime(
  boot: Bootstrap,
  eventing: Eventing,
  sessionId?: string
): AgentRuntime {
  const { projectRoot, sandboxRoot, sessionsDir, mcpConfigPath, configPath } = boot;
  const token = process.env.AGENT_API_TOKEN;
  const deps: AgentRuntimeDeps = {
    mcpConfigPath,
    configPath,
    sessionsDir,
    workspaceRoot: projectRoot,
    sandboxRoot,
    logger: boot.logger,
    credentials: token ? { token } : {},
    orchestratorRole: "orchestrator",
    parentSignal: boot.rootSignal,
    // The host's bus: the runtime chains its own under this, so runtime events
    // bubble up here to the CLI.
    eventing,
  };
  return buildRuntimeRef(deps, sessionId);
}

// interactive e.g. user request/response
async function runInteractive(boot: Bootstrap): Promise<void> {
  const { projectRoot, sandboxRoot, sessionsDir, configPath } = boot;

  const saved = await AgentRuntime.listSavedSessions(sessionsDir);
  const choice = await pickSession(saved);

  // Host bus the runtime chains under. The REPL owns the terminal via its scroll
  // region (ScreenLayout) and is the SOLE writer; no out-of-band status line here
  // — a raw write to the shared TTY would land inside the pinned-prompt region.
  // Activity is already shown by the spinner; completion by the turn events.
  const eventing = new Eventing();

  const runtime = await buildRuntime(boot, eventing, choice.kind === "resume" ? choice.sessionId : undefined).build();
  boot.registerRuntime(runtime);

  // Drain any sub-sessions that outlive a turn before the REPL exits.
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
    // Bounded drain (escalates to abort on expiry) so a hung child can't wedge
    // the process; the scope cancel releases token-holding resources.
    await runtime.shutdown({ mode: "drain", timeoutMs: 30_000 });
  }
}

// headless e.g. job 1 time run
async function runHeadless(
  boot: Bootstrap,
  input: string,
  sessionId?: string
): Promise<number> {
  try {
    // Host bus — same role as interactive; progress already goes to stderr here.
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

    // Turn events arrive on the runtime's bus; map {type,payload} to the
    // renderer's {type,data} at this boundary. Progress is on stdout here.
    const unsubEvents = runtime.getEvents().subscribe((event) =>
      process.stdout.write(formatEvent({ type: event.type, data: event.payload } as RunnerEvent))
    );

    try {
      // The process root is the turn's cutoff: SIGINT/SIGTERM abort it (via the
      // bootstrap handlers), cutting the in-flight model/tool/sub-run awaits.
      const result = await runtime.dispatchAsync(input, { signal: boot.rootSignal });
      await runtime.awaitSubSessions();
      process.stdout.write(result.finalMessage.content + "\n");
      // Same identity summary the REPL prints on exit; stderr keeps stdout
      // reserved for the final answer.
      renderSession(bannerSessionOf(runtime, sessionId !== undefined), (text) =>
        void process.stderr.write(text)
      );
      return result.outcome === "satisfied"
        ? EXIT_SATISFIED
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

// ---------------------------------------------------------------------------
// BEGIN
// ---------------------------------------------------------------------------


main().catch((err) => {
  process.stderr.write(chalk.red(`\n[fatal] ${(err as Error).stack ?? err}\n`));
  process.exit(EXIT_ERROR);
});
