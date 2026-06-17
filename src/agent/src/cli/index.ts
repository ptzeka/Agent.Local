#!/usr/bin/env node
// composition root: boots shared infrastructure, then each run mode builds its own runtime after resolving a session
// interactive: picker → build() → REPL; headless: args.sessionId → build() → single dispatch → exit

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import url from "node:url";

import chalk from "chalk";
import dotenv from "dotenv";

import { AgentRuntime } from "../agent/runtime/agent-runtime.js";
import { Eventing } from "@agent-local/common/eventing";
import { FileLogger } from "@agent-local/common/filelogger";
import { ILogger } from "@agent-local/common/ilogger";
import type { AgentRuntimeDeps } from "../agent/runtime/types.js";
import type { RunnerEvent } from "../agent/runners/runner-events.js";
import { buildRuntime as buildRuntimeRef } from "../agent/runtime/build-runtime.js";
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
  logger: ILogger;
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

  // runtimes are built later per run mode, so the handlers hold a slot the run mode fills via registerRuntime
  const root = new AbortController();
  const logger = new FileLogger();
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


// streamOutput defaults off; only the interactive REPL (a live incremental renderer) opts in
function buildRuntime(
  boot: Bootstrap,
  eventing: Eventing,
  sessionId?: string,
  streamOutput = false
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
    // host's bus: the runtime chains its own under this, so runtime events bubble up to the CLI
    eventing,
    streamOutput,
  };
  return buildRuntimeRef(deps, sessionId);
}

// interactive e.g. user request/response
async function runInteractive(boot: Bootstrap): Promise<void> {
  const { projectRoot, sandboxRoot, sessionsDir, configPath } = boot;

  const saved = await AgentRuntime.listSavedSessions(sessionsDir);
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
