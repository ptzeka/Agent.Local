import { type Eventing, type ILogger as Logger } from "@agent-local/common";

// the seam every feature workspace mounts through: it receives the host's bus, logger, and root signal
// nothing crosses the seam by direct call — engines couple only through `bus`
export type MountContext = {
  bus: Eventing;
  logger: Logger;
  signal: AbortSignal;
};

export type Mount = (app: import("express").Express, ctx: MountContext) => void;

export type { Logger };
