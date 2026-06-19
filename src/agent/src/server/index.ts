import express from "express";
import { Eventing, type ILogger } from "@agent-local/common";
import { loadAgentSettings } from "./appsettings.js";
import { createReceiveApi } from "./comms/receiver.js";
import { createSessionApi } from "./session-api.js";
import { SessionRegistry } from "./session-registry.js";
import { HttpResultSender } from "./comms/sender.js";
import { configContextMiddleware } from "./middleware/config_context.js";
import { loggerContextMiddleware } from "./middleware/logger_context.js";
import { eventingContextMiddleware } from "./middleware/eventing_context.js";
import { userContextMiddleware } from "./middleware/user_context.js";
import { runtimeContextMiddleware } from "./middleware/runtime_context.js";
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
  // the agent owns the sessions it mints; lives across requests for the process, so it is built once here
  const sessions = new SessionRegistry();

  // wire the agent's client-credentials only when fully configured; otherwise the sender posts unauthenticated,
  // which the host accepts only while /receive enforcement is staged off
  const auth = settings.authentication;
  const credentials =
    auth.tokenUrl && auth.clientId && auth.clientSecret
      ? { tokenUrl: auth.tokenUrl, clientId: auth.clientId, clientSecret: auth.clientSecret }
      : undefined;
  if (!credentials) logger.warn?.("[agent-server] no client credentials configured — /receive posts will be unauthenticated");
  new HttpResultSender(bus, settings.host.receiveUrl, logger, credentials).start();

  // order is load-bearing, mirroring the Sandbox/console chain: body parse, then context middleware
  // config -> logger -> eventing -> user -> runtime (config first; the rest read req it seeds). healthz
  // sits before user/runtime so a liveness probe never builds a runtime; the API router runs last so it
  // finds the caller's runtime, bus and signal already resolved on req. runtime_context owns the
  // per-principal runtime registry + construction (no separate manager) and retains no teardown handle:
  // every runtime's parentSignal is root.signal, so the shutdown abort below cascades to release them.
  app.use(express.json());
  app.use(configContextMiddleware(settings));
  app.use(loggerContextMiddleware(logger));
  app.use(eventingContextMiddleware(bus));
  app.get("/healthz", (_req, res) => res.json({ status: "ok" }));
  // the agent validates the bearer JWT against the host's JWKS, fetched from authorityUrl on first verify
  const getKey = createJwksProvider(settings.authentication.authorityUrl ?? "", logger);
  app.use(userContextMiddleware(getKey, sessions));
  // session lifecycle mounts BEFORE the runtime middleware: minting/closing a session needs no runtime, and
  // routing it through runtime_context would build a per-request runtime (and spurious session state) for it
  app.use(createSessionApi(sessions));
  app.use(runtimeContextMiddleware({ signal: root.signal }));
  app.use(createReceiveApi());

  const port = Number(process.env.AGENT_PORT) || settings.port;
  const server = app.listen(port, () => logger.info(`[agent-server] listening on :${port}`));

  // one signal tears everything down: abort cascades to every runtime (parentSignal === root.signal), so
  // MCP clients self-dispose and in-flight turns flush via their finally — no per-runtime teardown to await
  const shutdown = (): void => {
    root.abort("process-shutdown");
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main();
