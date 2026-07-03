import type { Request, Response, Router } from "express";
import type { ILogger } from "@agent-local/common";
import type { WorkRecord, WorkStatus, WorkStore } from "../../work/work-store.js";

// ---------------------------------------------------------------------------
// Express doubles
// ---------------------------------------------------------------------------

// run a route's FULL express layer chain (permission guards included) with a fake req/res, no HTTP; a layer
// that responds instead of calling next() ends the chain, exactly as express would
export function routeFor(router: Router, method: string, path: string): (req: Request, res: Response) => Promise<void> {
  const stack = (router as unknown as {
    stack: {
      route?: {
        path: string;
        methods: Record<string, boolean>;
        stack: { handle: (req: Request, res: Response, next: () => void) => unknown }[];
      };
    }[];
  }).stack;
  const layer = stack.find((l) => l.route?.path === path && l.route?.methods[method]);
  if (!layer?.route) throw new Error(`${method.toUpperCase()} ${path} not mounted`);
  const handlers = layer.route.stack.map((s) => s.handle);
  return async (req, res) => {
    for (const handle of handlers) {
      let advanced = false;
      await handle(req, res, () => {
        advanced = true;
      });
      if (!advanced) return;
    }
  };
}

// the caller as userContextMiddleware would resolve it; omit userId to simulate no verified identity.
// permissions default to the full workflow set so a test only narrows them when the guard is the subject.
export function makeReq(opts: {
  userId?: string;
  permissions?: string[];
  params?: Record<string, string>;
  query?: Record<string, unknown>;
  body?: unknown;
  accessToken?: string;
} = {}): Request {
  return {
    params: opts.params ?? {},
    query: opts.query ?? {},
    body: opts.body ?? {},
    userContext: {
      permissions: opts.permissions ?? (opts.userId ? ["workflow:read", "workflow:write"] : []),
      userInfo: opts.userId ? { sub: opts.userId } : null,
      accessToken: opts.accessToken ?? null,
    },
  } as unknown as Request;
}

// statusCode starts at 200 because express defaults an un-set status to 200 on a plain res.json()
export function makeRes(): Response & { statusCode: number; jsonBody: unknown } {
  const res = {
    statusCode: 200,
    jsonBody: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.jsonBody = body;
      return this;
    },
  };
  return res as unknown as Response & { statusCode: number; jsonBody: unknown };
}

// ILogger's methods are all optional-chained at the call sites, so an empty object silences everything
export const noopLogger = {} as ILogger;

// ---------------------------------------------------------------------------
// Work doubles
// ---------------------------------------------------------------------------

// a fully-populated record so a test only states the fields it is about
export function workRecord(overrides: Partial<WorkRecord> & { workId: string; userId: string }): WorkRecord {
  return {
    workflowId: "wf-1",
    workspaceId: "ws-1",
    status: "running" as WorkStatus,
    step: null,
    temporalId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ts: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// an in-memory WorkStore over fixed records, exposing the cli-session bindings so a test can seed and assert them
export function fakeWorks(records: WorkRecord[] = []): WorkStore & { cliSessions: Map<string, string> } {
  const cliSessions = new Map<string, string>();
  const store = {
    cliSessions,
    async get(workId: string): Promise<WorkRecord | null> {
      return records.find((r) => r.workId === workId) ?? null;
    },
    async search(filter?: { userId?: string; status?: WorkStatus }): Promise<WorkRecord[]> {
      return records.filter(
        (r) => (!filter?.userId || r.userId === filter.userId) && (!filter?.status || r.status === filter.status),
      );
    },
    async getCliSessionId(workId: string): Promise<string | null> {
      return cliSessions.get(workId) ?? null;
    },
    async setCliSessionId(workId: string, sessionId: string): Promise<void> {
      cliSessions.set(workId, sessionId);
    },
  };
  return store as unknown as WorkStore & { cliSessions: Map<string, string> };
}
