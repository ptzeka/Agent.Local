import express from "express";
import { Eventing, type ILogger } from "@agent-local/common";
import { mount as mountWorkflow } from "@agent-local/workflow";
import { mount as mountWeb } from "@agent-local/web";
import { type MountContext } from "./mount.js";
import { loadAppSettings } from "./appsettings.json";
import { createReceiveApi } from "./api/receive.js";
import { HttpJobSender } from "./agent-client.js";

const DEFAULT_PORT = 3011;

// console-backed ILogger: the host owns the process lifecycle, so it logs without depending on FileLogger's filesystem
const logger: ILogger = {
  error: (message, ...args) => console.error(message, ...args),
  warn: (message, ...args) => console.warn(message, ...args),
  info: (message, ...args) => console.info(message, ...args),
  debug: (message, ...args) => console.debug(message, ...args),
};

// composition root: one bus + one root signal. The agent now runs as a SEPARATE service, so it is wired
// over HTTP (agent-client sends jobs, /receive takes answers) instead of mounted in-process; workflow and
// web still mount on the bus. Order is load-bearing: the receiver route and the workflow publisher must be
// in place before web, whose SSR catch-all (app.get(/.*/)) would otherwise shadow /receive and /workflow.
async function main(): Promise<void> {
  const root = new AbortController();
  const bus = new Eventing();
  const app = express();
  const settings = loadAppSettings();
  const ctx: MountContext = { bus, logger, signal: root.signal, settings };

  app.use(express.json());
  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use(createReceiveApi(bus, logger));                           // POST /receive -> republish onto the bus
  new HttpJobSender(bus, settings.agent.baseUrl, logger).start();   // workflow.job -> HTTP -> agent service
  mountWorkflow(app, ctx);  // camunda bridge: /workflow/* routes + Zeebe client (publishes workflow.*)
  mountWeb(app, ctx);       // React SSR: /static, /public, /events SSE, then the SSR catch-all (last)
  logger.info("[host] wired agent-client + /receive, mounted workflow, web");

  const port = Number(process.env.PORT) || settings.host.port || DEFAULT_PORT;
  const server = app.listen(port, () => {
    logger.info(`[host] listening on :${port}`);
  });

  const shutdown = (): void => {
    root.abort("process-shutdown");
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main();
