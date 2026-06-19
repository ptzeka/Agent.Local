import express from "express";
import { Eventing, type ILogger } from "@agent-local/common";
import { loadAgentSettings } from "./appsettings.js";
import { createApi } from "./api.js";
import { HttpResultSender } from "./sender.js";
import { configContextMiddleware } from "./middleware/config_context.js";
import { loggerContextMiddleware } from "./middleware/logger_context.js";
import { eventingContextMiddleware } from "./middleware/eventing_context.js";
import { userContextMiddleware } from "./middleware/user_context.js";
import { runtimeContextMiddleware } from "./middleware/runtime_context.js";
import { createPublicKeyProvider } from "./auth/public-key.js";

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

  new HttpResultSender(bus, settings.host.receiveUrl, logger).start();

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
  // the agent validates the bearer JWT offline against the host's public key, fetched once from authorityUrl
  const getPublicKey = createPublicKeyProvider(settings.authentication.authorityUrl ?? "", logger);
  app.use(userContextMiddleware(getPublicKey));
  app.use(runtimeContextMiddleware({ signal: root.signal }));
  app.use(createApi());

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
