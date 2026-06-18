import type { Eventing, ILogger, AppSettings } from "@agent-local/common";

// public type for the host's static import. Hand-authored because the agent build emits no declarations
// (tsconfig declaration:false). Keep in sync with src/worker/mount.ts.
export interface MountContext {
  bus: Eventing;
  logger: ILogger;
  signal: AbortSignal;
  settings?: AppSettings;
}

export declare const mount: (app: unknown, ctx: MountContext) => void;
