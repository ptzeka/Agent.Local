import express from "express";
import { Eventing } from "@agent-local/common";
import type { ILogger } from "@agent-local/common/ilogger";
import { mount } from "./mount.js";

// console-backed ILogger for the standalone daemon; the co-hosted path receives the host's logger via ctx
const logger: ILogger = {
  error: (m, ...a) => console.error(m, ...a),
  warn: (m, ...a) => console.warn(m, ...a),
  info: (m, ...a) => console.info(m, ...a),
  debug: (m, ...a) => console.debug(m, ...a),
};

// standalone bootstrap: one root AbortController minted at the source, threaded down as ctx.signal (CLI parity)
// SIGINT/SIGTERM aborts the root so the Zeebe client drains and the process exits clean
function main(): void {
  const root = new AbortController();
  const bus = new Eventing();
  const app = express();
  app.use(express.json());

  mount(app, { bus, logger, signal: root.signal });

  const port = Number(process.env.WORKFLOW_PORT ?? 3100);
  const server = app.listen(port, () => logger.info(`[workflow] listening on :${port}`));

  const shutdown = () => {
    root.abort();
    server.close();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main();
