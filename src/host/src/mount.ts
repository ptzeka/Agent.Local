import { type Eventing, type ILogger as Logger, type AppSettings } from "@agent-local/common";
import { type DatabaseHandle } from "@agent-local/common/db";
import { type ResolveUser } from "@agent-local/web";
import { type JobRegistry } from "./jobs/job-registry.js";

// the seam every feature workspace mounts through: it receives the host's bus, logger, root signal, and
// the whole resolved appsettings. Nothing crosses the seam by direct call — engines couple only through
// `bus`; each feature reads the appsettings section it needs. `jobs` is the one host-owned service on the
// seam: the work-unit registry features read/update directly (status/step), since it IS the host's state.
export type MountContext = {
  bus: Eventing;
  logger: Logger;
  signal: AbortSignal;
  settings: AppSettings;
  jobs: JobRegistry;
  // host.sqlite handle, opened once at startup and injected; the job repository reads/writes it once M3-H lands
  db?: DatabaseHandle;
  // host-provided session resolver passed through to the web mount (decrypts the cookie ticket -> identity)
  resolveUser?: ResolveUser;
};

export type Mount = (app: import("express").Express, ctx: MountContext) => void;

export type { Logger };
