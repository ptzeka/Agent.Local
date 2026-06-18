import express from "express";
import { Eventing, type ILogger } from "@agent-local/common";
import { mount as mountAgent } from "@agent-local/agent/mount";
import { mount as mountWorkflow } from "@agent-local/workflow";
import { mount as mountWeb } from "@agent-local/web";
import { type MountContext } from "./mount.js";
import { loadAppSettings } from "./appsettings.js";

const DEFAULT_PORT = 3011;

// console-backed ILogger: the host owns the process lifecycle, so it logs without depending on FileLogger's filesystem
const logger: ILogger = {
  error: (message, ...args) => console.error(message, ...args),
  warn: (message, ...args) => console.warn(message, ...args),
  info: (message, ...args) => console.info(message, ...args),
  debug: (message, ...args) => console.debug(message, ...args),
};

// composition root: one bus + one root signal, shared into every mount so cancellation flows down and
// events bubble up. Engines couple ONLY through the bus — each mount(app, ctx) is a bridge, never a peer
// call. Mount order is load-bearing: the agent must subscribe before workflow's Zeebe client starts
// publishing, and web mounts LAST because its SSR catch-all (app.get(/.*/)) would shadow real routes.
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

  mountAgent(app, ctx);     // bus-only bridge: workflow.job -> runtime -> agent.result (subscribe first)
  mountWorkflow(app, ctx);  // camunda bridge: /workflow/* routes + Zeebe client (publishes workflow.*)
  mountWeb(app, ctx);       // React SSR: /static, /public, /events SSE, then the SSR catch-all (last)
  logger.info("[host] mounted agent, workflow, web");

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
