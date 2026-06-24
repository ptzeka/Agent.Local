import { describe, expect, test } from "@jest/globals";
import type { Request, Response, Router } from "express";
// eventing subpath, not the index: the index transitively pulls jwt -> jose (ESM-only) which ts-jest's
// commonjs transform cannot load; eventing.ts has no such dependency
import { Eventing } from "@agent-local/common/eventing";
import { createSessionApi } from "../../src/server/api/session-api.js";
import { SessionRegistry } from "../../src/server/session-registry.js";
import { createSession, type Session } from "../../src/agent/session/session.js";
import type { SessionStore } from "../../src/agent/session/session-store.js";
import { EXECUTION_CANCEL, EXECUTION_INTERRUPT } from "../../src/server/comms/contract.js";

// reach a handler out of the express router so the test drives it with a fake req/res, no HTTP
function handlerFor(router: Router, method: string, path: string): (req: Request, res: Response) => unknown {
  const stack = (router as unknown as {
    stack: { route?: { path: string; methods: Record<string, boolean>; stack: { handle: (req: Request, res: Response) => unknown }[] } }[];
  }).stack;
  const layer = stack.find((l) => l.route?.path === path && l.route?.methods[method]);
  if (!layer?.route) throw new Error(`${method.toUpperCase()} ${path} not mounted`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

// an in-memory SessionStore that records every save so a test can assert what (and whether) it persisted
function fakeStore(seed?: Session): SessionStore & { saved: Session[] } {
  const saved: Session[] = seed ? [seed] : [];
  const store = {
    saved,
    async load(id: string): Promise<Session | null> {
      return saved.find((s) => s.sessionId === id) ?? null;
    },
    async save(s: Session): Promise<void> {
      const i = saved.findIndex((x) => x.sessionId === s.sessionId);
      if (i >= 0) saved[i] = s;
      else saved.push(s);
    },
  };
  return store as unknown as SessionStore & { saved: Session[] };
}

function makeReq(opts: { permissions?: string[]; body?: unknown }): Request {
  return {
    body: opts.body ?? {},
    userContext: { permissions: opts.permissions ?? ["agent:trigger"] },
  } as unknown as Request;
}

function makeRes(): Response & { statusCode: number; jsonBody: unknown } {
  const res = {
    statusCode: 0,
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

describe("session-api POST /session/create", () => {
  test("rejects 403 when the caller lacks agent:trigger and persists nothing", async () => {
    const store = fakeStore();
    const router = createSessionApi(new SessionRegistry(), store, new Eventing());
    const res = makeRes();
    await handlerFor(router, "post", "/session/create")(
      makeReq({ permissions: [], body: { workspaceId: "ws", workId: "work-1" } }),
      res,
    );
    expect(res.statusCode).toBe(403);
    expect(store.saved).toHaveLength(0);
  });

  test("rejects 400 when workspaceId or workId is missing", async () => {
    const store = fakeStore();
    const router = createSessionApi(new SessionRegistry(), store, new Eventing());
    const res = makeRes();
    await handlerFor(router, "post", "/session/create")(makeReq({ body: { workspaceId: "ws" } }), res);
    expect(res.statusCode).toBe(400);
    expect(store.saved).toHaveLength(0);
  });

  test("mints a session and stamps externalReferenceKey = workId on first create", async () => {
    const store = fakeStore();
    const router = createSessionApi(new SessionRegistry(), store, new Eventing());
    const res = makeRes();
    await handlerFor(router, "post", "/session/create")(
      makeReq({ body: { workspaceId: "ws", workId: "work-1", sessionId: "sess-1" } }),
      res,
    );
    expect(res.statusCode).toBe(201);
    expect(res.jsonBody).toEqual({ sessionId: "sess-1" });
    expect(store.saved).toHaveLength(1);
    expect(store.saved[0]).toMatchObject({
      sessionId: "sess-1",
      workspaceId: "ws",
      externalReferenceKey: "work-1",
    });
  });

  test("a reuse/rehydrate of an existing session does not re-save (externalReferenceKey never drifts)", async () => {
    // the session already exists with its original reference; a second create for the same id must not rewrite it
    const seed = { ...createSession({ sessionId: "sess-1", workspaceId: "ws", conversationId: "conv-1" }), externalReferenceKey: "work-orig" };
    const store = fakeStore(seed);
    const router = createSessionApi(new SessionRegistry(), store, new Eventing());
    const res = makeRes();
    await handlerFor(router, "post", "/session/create")(
      makeReq({ body: { workspaceId: "ws", workId: "work-different", sessionId: "sess-1" } }),
      res,
    );
    expect(res.statusCode).toBe(201);
    expect(store.saved).toHaveLength(1);
    expect(store.saved[0].externalReferenceKey).toBe("work-orig");
  });
});

describe("session-api POST /session/close", () => {
  test("publishes EXECUTION_CANCEL and marks the persisted session done", async () => {
    const bus = new Eventing();
    const cancelled: string[] = [];
    bus.subscribe(EXECUTION_CANCEL, (e) => cancelled.push((e.payload as { sessionId: string }).sessionId));

    const seed = createSession({ sessionId: "sess-1", workspaceId: "ws", conversationId: "conv-1" });
    const store = fakeStore(seed);
    const router = createSessionApi(new SessionRegistry(), store, bus);
    const res = makeRes();
    await handlerFor(router, "post", "/session/close")(makeReq({ body: { sessionId: "sess-1" } }), res);

    expect(res.statusCode).toBe(202);
    expect(cancelled).toEqual(["sess-1"]);
    expect(store.saved[0].status).toBe("done");
  });

  test("a missing sessionId is a 202 no-op that publishes nothing", async () => {
    const bus = new Eventing();
    let published = 0;
    bus.subscribe(EXECUTION_CANCEL, () => (published += 1));
    const router = createSessionApi(new SessionRegistry(), fakeStore(), bus);
    const res = makeRes();
    await handlerFor(router, "post", "/session/close")(makeReq({ body: {} }), res);
    expect(res.statusCode).toBe(202);
    expect(res.jsonBody).toEqual({ closed: false });
    expect(published).toBe(0);
  });
});

describe("session-api POST /session/interrupt", () => {
  test("publishes EXECUTION_INTERRUPT for the session without closing it", async () => {
    const bus = new Eventing();
    const interrupted: string[] = [];
    bus.subscribe(EXECUTION_INTERRUPT, (e) => interrupted.push((e.payload as { sessionId: string }).sessionId));
    const router = createSessionApi(new SessionRegistry(), fakeStore(), bus);
    const res = makeRes();
    await handlerFor(router, "post", "/session/interrupt")(makeReq({ body: { sessionId: "sess-1" } }), res);
    expect(res.statusCode).toBe(202);
    expect(res.jsonBody).toEqual({ interrupted: true });
    expect(interrupted).toEqual(["sess-1"]);
  });
});
