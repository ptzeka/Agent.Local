import express from "express";
import { Eventing, type ILogger } from "@agent-local/common";
import { loadAgentSettings } from "./appsettings.js";
import { SessionManager } from "./session-manager.js";
import { createApi } from "./api.js";
import { HttpResultSender } from "./sender.js";

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
  app.use(express.json());

  const sessions = new SessionManager(bus, root.signal, logger, settings.workspace, settings.sessionsDir);
  new HttpResultSender(bus, settings.host.receiveUrl, logger).start();

  app.get("/healthz", (_req, res) => res.json({ status: "ok" }));
  app.use(createApi(sessions, logger));

  const port = Number(process.env.AGENT_PORT) || settings.port;
  const server = app.listen(port, () => logger.info(`[agent-server] listening on :${port}`));

  const shutdown = (): void => {
    void sessions.closeAll().finally(() => {
      root.abort("process-shutdown");
      server.close(() => process.exit(0));
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main();
