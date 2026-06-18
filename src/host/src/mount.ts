import { type Eventing, type ILogger as Logger, type AppSettings } from "@agent-local/common";

// the seam every feature workspace mounts through: it receives the host's bus, logger, root signal, and
// the whole resolved appsettings. Nothing crosses the seam by direct call — engines couple only through
// `bus`; each feature reads the appsettings section it needs.
export type MountContext = {
  bus: Eventing;
  logger: Logger;
  signal: AbortSignal;
  settings: AppSettings;
};

export type Mount = (app: import("express").Express, ctx: MountContext) => void;

export type { Logger };
