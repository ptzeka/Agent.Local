import express from "express";
import { Eventing, type ILogger } from "@agent-local/common";
import { type MountContext } from "./mount.js";
import { wireCamunda } from "./wiring/camunda.js";
import { wireApi } from "./wiring/api.js";
import { wireAgentWorker } from "./wiring/agent-worker.js";

const DEFAULT_PORT = 3011;

// console-backed ILogger: the host owns the process lifecycle, so it logs without depending on FileLogger's filesystem
const logger: ILogger = {
  error: (message, ...args) => console.error(message, ...args),
  warn: (message, ...args) => console.warn(message, ...args),
  info: (message, ...args) => console.info(message, ...args),
  debug: (message, ...args) => console.debug(message, ...args),
};

// composition root: one bus + one root signal, wired before anything mounts so cancellation flows down
// and events bubble up. Every engine couples ONLY through the bus — these three wire* calls are the seams.
async function main(): Promise<void> {
  const root = new AbortController();
  const bus = new Eventing();
  const app = express();
  const ctx: MountContext = { bus, logger, signal: root.signal };

  wireCamunda(bus);                 // camunda mesh: workflow.job -> agent.job (correlated)
  await wireApi(app, ctx);          // express json + /healthz + web & workflow HTTP mounts
  await wireAgentWorker(app, ctx);  // agent worker (bus-only): agent.job -> agent.result

  const port = Number(process.env.PORT) || DEFAULT_PORT;
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
