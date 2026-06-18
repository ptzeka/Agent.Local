import type { Express } from "express";
import type { Eventing, ILogger } from "@agent-local/common";

// public type for the host's static import. Hand-authored because the web bundle is built by webpack
// (babel, no tsc emit), so no declaration is generated from src/server/mount.tsx. Keep in sync with it.
export interface MountContext {
  bus: Eventing;
  logger: ILogger;
  signal: AbortSignal;
}

export declare const mount: (app: Express, ctx: MountContext) => void;
