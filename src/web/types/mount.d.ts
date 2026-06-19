import type { Express, Request } from "express";
import type { Eventing, ILogger, AppSettings } from "@agent-local/common";

// public types for the host's static import. Hand-authored because the web bundle is built by webpack
// (babel, no tsc emit), so no declaration is generated from src/server/mount.tsx. Keep in sync with it.
export interface ResolvedUser {
  userInfo: { userId: string; userName: string; firstName: string; lastName: string };
  permissions: string[];
  accessToken: string;
}

export type ResolveUser = (req: Request) => Promise<ResolvedUser | null> | ResolvedUser | null;

export interface MountContext {
  bus: Eventing;
  logger: ILogger;
  signal: AbortSignal;
  settings?: AppSettings;
  resolveUser?: ResolveUser;
}

export declare const mount: (app: Express, ctx: MountContext) => void;
