import { type Eventing, type ILogger as Logger, type AppSettings } from "@agent-local/common";
import { type DatabaseHandle } from "@agent-local/common/db";
import { type ResolveUser } from "@agent-local/web";
import { type WorkStore } from "./work/work-store.js";

// the seam every feature workspace mounts through: it receives the host's bus, logger, root signal, and
// the whole resolved appsettings. Nothing crosses the seam by direct call — engines couple only through
// `bus`; each feature reads the appsettings section it needs. `works` is the one host-owned service on the
// seam: the work-unit store features read/update directly (status/step), since it IS the host's state.
export type MountContext = {
  bus: Eventing;
  logger: Logger;
  signal: AbortSignal;
  settings: AppSettings;
  works: WorkStore;
  // host.sqlite handle, opened once at startup and injected; the work store reads/writes it
  db?: DatabaseHandle;
  // host-provided session resolver passed through to the web mount (decrypts the cookie ticket -> identity)
  resolveUser?: ResolveUser;
};

export type Mount = (app: import("express").Express, ctx: MountContext) => void;

export type { Logger };
