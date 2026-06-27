import { fileURLToPath } from "node:url";
import { NativeConnection, Worker } from "@temporalio/worker";
import type { Eventing } from "@agent-local/common";
import type { ILogger } from "@agent-local/common/ilogger";
import type { TemporalConfig } from "./config.js";
import { createAgentActivities } from "./workflows/_shared/activities.js";

// host-side worker: long-polls the task queue and executes the workflow + activity code the server dispatches.
// MUST run in the host process (not temporalhost) because dispatchAgentTask publishes onto the host bus.
// dials out to the server and self-drives from there; no per-run input — work arrives as start args + signals.
export async function startWorker(cfg: TemporalConfig, bus: Eventing, logger: ILogger, signal: AbortSignal): Promise<Worker> {
  // the worker uses NativeConnection (Rust core), not the client Connection; same address, same optional host bearer
  const connection = await NativeConnection.connect({
    address: cfg.address,
    metadata: cfg.authToken ? { authorization: `Bearer ${cfg.authToken}` } : undefined,
  });

  const worker = await Worker.create({
    connection,
    namespace: cfg.namespace,
    taskQueue: cfg.taskQueue,
    // resolved against dist at runtime; the SDK bundles this barrel (and every workflow it re-exports) into the sandbox
    workflowsPath: fileURLToPath(new URL("./workflows/index.js", import.meta.url)),
    // activities run on the main event loop, so the bus publish in dispatchAgentTask reaches the agent
    activities: createAgentActivities(bus),
  });

  signal.addEventListener("abort", () => void worker.shutdown(), { once: true });

  // run() is the background poll-loop; it resolves only after shutdown, so close the connection then
  void worker
    .run()
    .catch((err) => logger.error(`[temporal] worker stopped: ${String(err)}`))
    .finally(() => void connection.close());

  logger.info(`[temporal] worker polling taskQueue=${cfg.taskQueue}`);
  return worker;
}
