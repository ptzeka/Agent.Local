import express from "express";
import { Container, Eventing, AccessTokenProvider, type ILogger } from "@agent-local/common";
import { openDatabase } from "@agent-local/common/db";
import { resolveAgentDbFile } from "../db/db-schema.js";
import { SessionStore } from "../agent/session/session-store.js";
import { loadAgentSettings } from "./appsettings.js";
import { HttpReceiver } from "./comms/receiver.js";
import { ExecutionRunner } from "./comms/runner.js";
import { Heartbeat } from "./comms/heartbeat.js";
import { RuntimeBuilder } from "./comms/runtime-builder.js";
import { SseQueue } from "./comms/sse-queue.js";
import { SseReceiver } from "./comms/ssereceiver.js";
import { createSessionApi } from "./api/session-api.js";
import { SessionRegistry } from "./session-registry.js";
import { HttpResultSender } from "./comms/sender.js";
import { LOGGER, SERVER_CONFIG, DB, SESSION_STORE } from "./container-tokens.js";
import { containerMiddleware } from "./middleware/container_context.js";
import { userContextMiddleware } from "./middleware/user_context.js";
import { createJwksProvider } from "./auth/jwks.js";

// console-backed ILogger: this service owns its process lifecycle, so it logs without FileLogger's filesystem
const logger: ILogger = {
  error: (message, ...args) => console.error(message, ...args),
  warn: (message, ...args) => console.warn(message, ...args),
  info: (message, ...args) => console.info(message, ...args),
  debug: (message, ...args) => console.debug(message, ...args),
};

// standalone agent service: its own express app + internal bus, reached by the host over HTTP (receive
// API) and answering back via the sender's webhook. Runtime config is the agent's OWN appsettings.
async function main(): Promise<void> {
  const settings = loadAgentSettings();
  const root = new AbortController();
  const bus = new Eventing();
  const app = express();
  // open the agent DB connection once for the process; `db init` owns the schema, this only opens it.
  // every per-request runtime shares this one handle (one writer process per file). file from appsettings
  // (db.file), overridable by AGENT_DB_FILE for ops
  const db = openDatabase(resolveAgentDbFile(settings.db?.file));
  // the agent owns the sessions it mints; lives across requests for the process, so it is built once here
  const sessions = new SessionRegistry();
  // session-create persists the minted session to agent.sqlite so /receive can resume it; shares the one db handle
  const sessionStore = SessionStore.create(db);

  // wire the agent's client-credentials only when fully configured; otherwise the sender posts unauthenticated,
  // which the host accepts only while /receive enforcement is staged off
  const auth = settings.authentication;
  const credentials =
    auth.tokenUrl && auth.clientId && auth.clientSecret
      ? { tokenUrl: auth.tokenUrl, clientId: auth.clientId, clientSecret: auth.clientSecret }
      : undefined;
  if (!credentials) logger.warn?.("[agent-server] no client credentials configured — /receive posts will be unauthenticated");
  // one token-cache store (process singleton): the webhook path refreshes its bearer only past expiry instead
  // of minting one per post. registered under its clientId when configured; the sender passes that id to fetch.
  const resultTokens = new AccessTokenProvider(logger);
  if (credentials) resultTokens.register(credentials);
  new HttpResultSender(bus, settings.host.receiveUrl, logger, resultTokens, credentials?.clientId).start();

  // order is load-bearing, mirroring the Sandbox/console chain: body parse, then context middleware
  // config -> logger -> eventing -> user (config first; the rest read req it seeds). healthz sits before
  // user so a liveness probe stays cheap; the receiver runs last so it finds config/logger/eventing already
  // resolved on req. The runner (not the receiver) owns runtime construction and retains no teardown handle:
  // every runtime's parentSignal is root.signal, so the shutdown abort below releases them.
  // the one startup container: every process singleton registered once here, then handed to each request by
  // containerMiddleware (a reference, never rebuilt) so route handlers read them off req.container.get(handle).
  const container = new Container();
  container.set(LOGGER, logger);
  container.set(SERVER_CONFIG, settings);
  container.set(Eventing, bus);
  container.set(DB, db);
  container.set(SessionRegistry, sessions);
  container.set(SESSION_STORE, sessionStore);
  container.set(AccessTokenProvider, resultTokens);

  app.use(express.json());
  app.use(containerMiddleware(container));
  app.get("/healthz", (_req, res) => res.json({ status: "ok" }));
  // the agent validates the bearer JWT against the host's JWKS, fetched from authorityUrl on first verify
  const getKey = createJwksProvider(settings.authentication.authorityUrl ?? "", logger);
  app.use(userContextMiddleware(getKey, sessions));
  // session lifecycle mounts BEFORE the job receiver: minting/closing a session needs no runtime, and routing
  // it through the receiver would build a per-request runtime (and spurious session state) for it
  app.use(createSessionApi(sessions, sessionStore, bus));
  // one shared runtime builder (off root.signal + the shared db) and the live-connection registry the SSE read
  // half and the runner both speak: a live session routes input to its persistent runtime, a one-shot job builds
  // and drains. The SSE route mounts before the receiver — opening a stream needs no /receive turn.
  const runtimeBuilder = new RuntimeBuilder(root.signal, db, settings, logger);
  const sseQueue = new SseQueue();
  app.use(new SseReceiver(sessions, sseQueue, runtimeBuilder).routes());
  // the runner owns input routing off the bus: it injects into a live SSE runtime, or builds a runtime per queued
  // job, runs the turn, and drains it. the receiver is pure transport — it parses /receive, stamps provenance, and
  // publishes onto the bus the runner consumes; the sender POSTs the one-shot result back out.
  const runner = new ExecutionRunner(root.signal, runtimeBuilder, sseQueue, logger, bus);
  runner.start();
  app.use(new HttpReceiver(sessions).routes());

  // ambient 5-min heartbeat: one process timer for periodic upkeep. For now its only task is reaping orphan SSE
  // connections (dead tabs whose disconnect never fired) so a leaked runtime doesn't hold a session's live slot.
  new Heartbeat(5 * 60_000, root.signal, logger).register(() => runner.heartbeat()).start();

  const port = Number(process.env.AGENT_PORT) || settings.port;
  const server = app.listen(port, () => logger.info(`[agent-server] listening on :${port}`));

  // one signal tears everything down: abort cascades to every runtime (parentSignal === root.signal), so
  // MCP clients self-dispose and in-flight turns flush via their finally — no per-runtime teardown to await
  const shutdown = (): void => {
    root.abort("process-shutdown");
    server.close(() => {
      try {
        db.close();
      } catch {
        // teardown must keep unwinding
      }
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main();
