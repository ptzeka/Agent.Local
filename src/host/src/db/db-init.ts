import type { ILogger } from "@agent-local/common";
import { ensureHostDb, resolveHostDbFile } from "./db-file.js";

// explicit `db init` command: brings host.sqlite up to schema, then exits. Run once before launching the
// host (start.sh calls it) rather than on every process boot, so a serving process never races schema work.
const logger: ILogger = {
  error: (m, ...a) => console.error(m, ...a),
  warn: (m, ...a) => console.warn(m, ...a),
  info: (m, ...a) => console.info(m, ...a),
  debug: (m, ...a) => console.debug(m, ...a),
};

try {
  ensureHostDb(logger).close();
  logger.info(`[host] db init complete: ${resolveHostDbFile()}`);
} catch (err) {
  logger.error(`[host] db init failed: ${String(err)}`);
  process.exit(1);
}
