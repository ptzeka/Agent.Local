import express from "express";
import { Eventing, type ILogger } from "@agent-local/common";
import { mount as mountWorkflow } from "@agent-local/workflow";
import { mount as mountWeb } from "@agent-local/web";
import { type MountContext } from "./mount.js";
import { loadAppSettings } from "./appsettings.js";
import { createReceiveApi } from "./api/receive.js";
import { createAuthApi } from "./api/auth.js";
import { HttpJobSender } from "./agent-client.js";
import { Orchestrator } from "./orchestrator.js";
import { JobRegistry } from "./jobs/job-registry.js";
import { loadOrCreateKeyRing } from "./user/keys.js";

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
  // host-owned services added to the mount container; the job registry is the work-unit store features query
  const jobs = new JobRegistry();
  // host owns IAM: load (or first-run generate) the RS256 key ring so /api/login can sign tokens
  const keys = loadOrCreateKeyRing();
  const ctx: MountContext = { bus, logger, signal: root.signal, settings, jobs };

  app.use(express.json());
  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use(createAuthApi(keys, settings.host.iam, logger));          // POST /api/login (sign JWT) + GET /.well-known/jwks.json
  app.use(createReceiveApi(bus, logger));                           // POST /receive -> republish onto the bus
  const sender = new HttpJobSender(bus, settings.agent.baseUrl, logger);
  sender.start();                                                   // workflow.job -> HTTP -> agent service
  // the orchestrator owns the work unit: trigger provisions it, the bus updaters fold engine events onto jobs
  const orchestrator = new Orchestrator(bus, jobs, sender, logger);
  orchestrator.start();
  app.post("/workflow/trigger", (req, res) => {                     // + start a work unit by workflowId
    orchestrator
      .trigger(String(req.body?.workflowId ?? ""), req.headers.authorization)
      .then((workId) => res.status(202).json({ workId }))
      .catch((err) => res.status(503).json({ error: String(err) }));
  });
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
