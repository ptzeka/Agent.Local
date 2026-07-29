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
import { resolveAgentDbFile } from "../db/db-schema.js";
import { loadAgentSettings } from "../server/appsettings.js";
import { loadModelsFile, type RuntimeConfig } from "../agent/registries/index.js";
import { readMcpServerDefs } from "../agent/runtime/middleware/external-mcp.js";
import type { AgentRuntimeDeps } from "../agent/runtime/types.js";
import type { RunnerEvent } from "../agent/runners/runner-events.js";
import { buildRuntime as buildRuntimeRef } from "../agent/runtime/build-runtime.js";
import { findProjectRoot, moduleDir, resolveSandboxRoot, resolveSessionsDir } from "../paths.js";
import { ANONYMOUS_PRINCIPAL, type Principal } from "../agent/identity/types.js";
import { decodePrincipal } from "../agent/identity/decode-token.js";
import { parseArgs } from "./args.js";
import { login, loadCachedToken } from "./cli-auth.js";
import { trustLocalDevCa } from "./tls-trust.js";
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
  // models.json + mcp.json + the agent's appsettings, parsed once here and injected as objects into every runtime
  config: RuntimeConfig;
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

// set once in main() from --token; resolveToken() gives it top precedence everywhere a bearer is read
let explicitToken: string | undefined;

// single precedence chain for the whole CLI: --token > AGENT_API_TOKEN (service/CI) > cached login
function resolveToken(): string | undefined {
  return explicitToken ?? process.env.AGENT_API_TOKEN ?? loadCachedToken() ?? undefined;
}

async function main(): Promise<void> {
  // before any fetch: the login token exchange and provider calls verify TLS against the spliced store
  trustLocalDevCa();
  const args = parseArgs(process.argv.slice(2));
  explicitToken = args.token;
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

// the picker's "Log in" row: runs the PKCE loopback flow in-process so the picker can re-render scoped to
// the new identity right away; the bearer lands in ~/.config/agent-local/cli-token.json where buildRuntime's
// loadCachedToken() fallback picks it up, so the runtime built next injects this user without re-reading here.
// Returns null (stay anonymous) on any failure — login is an offer, never a gate.
async function tryInteractiveLogin(boot: Bootstrap): Promise<Principal | null> {
  const auth = boot.config.settings.authentication;
  if (!auth.authorityUrl || !auth.tokenUrl || !auth.nativeClientId) {
    process.stderr.write(chalk.red("[login] authentication.authorityUrl/tokenUrl/nativeClientId are not configured\n"));
    return null;
  }
  try {
    const cached = await login({ authorityUrl: auth.authorityUrl, tokenUrl: auth.tokenUrl, nativeClientId: auth.nativeClientId });
    const principal = decodePrincipal(cached.token);
    process.stdout.write(
      chalk.green(`Welcome ${displayNameOf(principal) ?? "unknown"}`) +
        chalk.gray(` — token (expires ${new Date(cached.expiresAtMs).toISOString()})\n`)
    );
    return principal;
  } catch (err) {
    process.stderr.write(chalk.red(`[login] ${(err as Error).message}\n`));
    return null;
  }
}

// picker/banner display name: the auth service's tokens carry userName; name/sub cover foreign tokens
function displayNameOf(principal: Principal | null): string | null {
  if (!principal) return null;
  const { userName, name } = principal.claims;
  return typeof userName === "string" ? userName : typeof name === "string" ? name : principal.sub;
}

// bootstrap args
async function bootstrap(): Promise<Bootstrap> {
  dotenv.config();

  const projectRoot = findProjectRoot(moduleDir(import.meta.url));

  const sandboxRoot = resolveSandboxRoot(projectRoot);
  fs.mkdirSync(sandboxRoot, { recursive: true });

  const sessionsDir = resolveSessionsDir(projectRoot);

  // parse every config file ONCE here at the composition root; the runtime receives objects, never paths
  const settings = loadAgentSettings();
  const config: RuntimeConfig = {
    models: loadModelsFile(path.join(projectRoot, "models.json")),
    settings,
    mcpServers: readMcpServerDefs(path.join(projectRoot, "mcp.json")),
  };

  // open the agent DB connection at startup; `db init` owns the schema, so this only opens (never reconciles).
  // the file comes from the agent's appsettings (db.file), overridable by AGENT_DB_FILE for ops
  const db = openDatabase(resolveAgentDbFile(settings.db?.file));

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
    config,
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
  const { projectRoot, sandboxRoot, sessionsDir, config } = boot;
  const db = boot.container.get(DB);
  const token = resolveToken();
  const deps: AgentRuntimeDeps = {
    config,
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
  const { projectRoot, sandboxRoot } = boot;
  const db = boot.container.get(DB);

  // the picker is always owner-scoped: a logged-in user sees their own sessions, a logged-out one only the
  // anonymous-owned bucket — never other users' sessions
  let principal = decodePrincipal(resolveToken());
  let choice = await pickSession(await AgentRuntime.listSavedSessions(db, principal?.sub ?? ANONYMOUS_PRINCIPAL.sub), {
    userName: displayNameOf(principal),
  });
  // the login row loops back into the picker so the user lands on their own sessions, not a stale list
  while (choice.kind === "login") {
    principal = (await tryInteractiveLogin(boot)) ?? principal;
    choice = await pickSession(await AgentRuntime.listSavedSessions(db, principal?.sub ?? ANONYMOUS_PRINCIPAL.sub), {
      userName: displayNameOf(principal),
    });
  }

  // no out-of-band status line: the REPL is the sole TTY writer, so a raw write would land in its pinned-prompt region
  const eventing = new Eventing();

  const runtime = await buildRuntime(boot, eventing, choice.kind === "resume" ? choice.sessionId : undefined, true).build();
  boot.registerRuntime(runtime);

  // sub-session reports are the REPL's to render: it subscribes through ScreenLayout, the sole TTY writer.
  // a second raw write here would desync readline's row count and the next repaint's erase would eat the line
  try {
    await runRepl({
      workspaceRoot: projectRoot,
      sandboxRoot,
      runtime,
      resumed: choice.kind === "resume",
    });
  } finally {
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

    // to stderr with the rest of the progress output, so stdout stays reserved for the final answer
    const unsubscribe = runtime.onSubSessionEvent((notification) =>
      process.stderr.write(formatSubSessionNotification(notification))
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
