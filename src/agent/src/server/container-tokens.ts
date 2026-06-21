import { token } from "@agent-local/common/container";
import type { ILogger } from "@agent-local/common/ilogger";
import type { DatabaseHandle } from "@agent-local/common/db";
import type { AgentServerSettings } from "./appsettings.js";
import type { SessionStore } from "../agent/session/session-store.js";

// handles for the process singletons that are interface/type-shaped (no runtime class to key by). class-shaped
// singletons — Eventing, SessionRegistry, AccessTokenProvider — register by their constructor instead, so they
// need no token here. SessionStore is built through a factory (private constructor), so it gets a token too.
// all are set into the one startup Container and read off req.container.
export const LOGGER = token<ILogger>("ILogger");
export const SERVER_CONFIG = token<AgentServerSettings>("AgentServerSettings");
export const DB = token<DatabaseHandle>("DatabaseHandle");
export const SESSION_STORE = token<SessionStore>("SessionStore");
