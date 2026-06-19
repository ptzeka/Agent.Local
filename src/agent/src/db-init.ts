import type { ILogger } from "@agent-local/common";
import { ensureAgentDb, resolveAgentDbFile } from "./agent/db-schema.js";

// explicit `db init` command: brings agent.sqlite up to schema, then exits. Run once before launching the
// agent server (start.sh calls it) rather than on every process boot, so a serving process never races it.
const logger: ILogger = {
  error: (m, ...a) => console.error(m, ...a),
  warn: (m, ...a) => console.warn(m, ...a),
  info: (m, ...a) => console.info(m, ...a),
  debug: (m, ...a) => console.debug(m, ...a),
};

try {
  ensureAgentDb(logger).close();
  logger.info(`[agent] db init complete: ${resolveAgentDbFile()}`);
} catch (err) {
  logger.error(`[agent] db init failed: ${String(err)}`);
  process.exit(1);
}
