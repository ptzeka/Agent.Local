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
    async getSessionById(id: string): Promise<Session | null> {
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

// userId is the verified token subject (the session owner). Omit it to simulate a call with no token identity.
function makeReq(opts: { userId?: string; body?: unknown }): Request {
  return {
    body: opts.body ?? {},
    userContext: {
      permissions: ["agent:trigger"],
      userInfo: opts.userId ? { serviceId: opts.userId, userId: opts.userId } : null,
    },
  } as unknown as Request;
}

// a persisted session already stamped with its durable owner (set by /session/create), so close/interrupt can
// resolve the owner from the store when the in-memory registry is empty
function ownedSession(sessionId: string, ownerUserId: string): Session {
  return {
    ...createSession({ sessionId, workspaceId: "ws", conversationId: "conv-1" }),
    user: { sub: ownerUserId, isAuthenticated: true, claims: {}, scopes: [] },
  };
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
  test("rejects 401 when the caller has no verified user identity and persists nothing", async () => {
    const store = fakeStore();
    const router = createSessionApi(new SessionRegistry(), store, new Eventing());
    const res = makeRes();
    await handlerFor(router, "post", "/session/create")(
      makeReq({ body: { workspaceId: "ws", workId: "work-1" } }),
      res,
    );
    expect(res.statusCode).toBe(401);
    expect(store.saved).toHaveLength(0);
  });

  test("rejects 400 when workspaceId or workId is missing", async () => {
    const store = fakeStore();
    const router = createSessionApi(new SessionRegistry(), store, new Eventing());
    const res = makeRes();
    await handlerFor(router, "post", "/session/create")(makeReq({ userId: "u1", body: { workspaceId: "ws" } }), res);
    expect(res.statusCode).toBe(400);
    expect(store.saved).toHaveLength(0);
  });

  test("mints a session, stamping externalReferenceKey = workId and the owner = token subject", async () => {
    const store = fakeStore();
    const router = createSessionApi(new SessionRegistry(), store, new Eventing());
    const res = makeRes();
    await handlerFor(router, "post", "/session/create")(
      makeReq({ userId: "u1", body: { workspaceId: "ws", workId: "work-1", sessionId: "sess-1" } }),
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
    // owner is stamped durably from the token subject, never the request body
    expect(store.saved[0].user?.sub).toBe("u1");
  });

  test("the body cannot assert a different owner than the token subject", async () => {
    const store = fakeStore();
    const router = createSessionApi(new SessionRegistry(), store, new Eventing());
    const res = makeRes();
    await handlerFor(router, "post", "/session/create")(
      makeReq({ userId: "u1", body: { workspaceId: "ws", workId: "work-1", sessionId: "sess-1", userId: "attacker" } }),
      res,
    );
    expect(res.statusCode).toBe(201);
    expect(store.saved[0].user?.sub).toBe("u1");
  });

  test("a reuse/rehydrate of an existing session does not re-save (externalReferenceKey never drifts)", async () => {
    // the session already exists with its original reference; a second create for the same id must not rewrite it
    const seed = { ...createSession({ sessionId: "sess-1", workspaceId: "ws", conversationId: "conv-1" }), externalReferenceKey: "work-orig" };
    const store = fakeStore(seed);
    const router = createSessionApi(new SessionRegistry(), store, new Eventing());
    const res = makeRes();
    await handlerFor(router, "post", "/session/create")(
      makeReq({ userId: "u1", body: { workspaceId: "ws", workId: "work-different", sessionId: "sess-1" } }),
      res,
    );
    expect(res.statusCode).toBe(201);
    expect(store.saved).toHaveLength(1);
    expect(store.saved[0].externalReferenceKey).toBe("work-orig");
  });
});

describe("session-api POST /session/close", () => {
  test("the owner's close publishes EXECUTION_CANCEL and marks the persisted session done", async () => {
    const bus = new Eventing();
    const cancelled: string[] = [];
    bus.subscribe(EXECUTION_CANCEL, (e) => cancelled.push((e.payload as { sessionId: string }).sessionId));

    const store = fakeStore(ownedSession("sess-1", "u1"));
    const router = createSessionApi(new SessionRegistry(), store, bus);
    const res = makeRes();
    await handlerFor(router, "post", "/session/close")(makeReq({ userId: "u1", body: { sessionId: "sess-1" } }), res);

    expect(res.statusCode).toBe(202);
    expect(cancelled).toEqual(["sess-1"]);
    expect(store.saved[0].status).toBe("done");
  });

  test("a non-owner is refused 403 and the session is neither cancelled nor marked done", async () => {
    const bus = new Eventing();
    const cancelled: string[] = [];
    bus.subscribe(EXECUTION_CANCEL, (e) => cancelled.push((e.payload as { sessionId: string }).sessionId));

    const store = fakeStore(ownedSession("sess-1", "u1"));
    const router = createSessionApi(new SessionRegistry(), store, bus);
    const res = makeRes();
    await handlerFor(router, "post", "/session/close")(makeReq({ userId: "attacker", body: { sessionId: "sess-1" } }), res);

    expect(res.statusCode).toBe(403);
    expect(cancelled).toEqual([]);
    expect(store.saved[0].status).not.toBe("done");
  });

  test("a missing sessionId is a 202 no-op that publishes nothing", async () => {
    const bus = new Eventing();
    let published = 0;
    bus.subscribe(EXECUTION_CANCEL, () => (published += 1));
    const router = createSessionApi(new SessionRegistry(), fakeStore(), bus);
    const res = makeRes();
    await handlerFor(router, "post", "/session/close")(makeReq({ userId: "u1", body: {} }), res);
    expect(res.statusCode).toBe(202);
    expect(res.jsonBody).toEqual({ closed: false });
    expect(published).toBe(0);
  });
});

describe("session-api POST /session/interrupt", () => {
  test("the owner's interrupt publishes EXECUTION_INTERRUPT without closing the session", async () => {
    const bus = new Eventing();
    const interrupted: string[] = [];
    bus.subscribe(EXECUTION_INTERRUPT, (e) => interrupted.push((e.payload as { sessionId: string }).sessionId));
    const store = fakeStore(ownedSession("sess-1", "u1"));
    const router = createSessionApi(new SessionRegistry(), store, bus);
    const res = makeRes();
    await handlerFor(router, "post", "/session/interrupt")(makeReq({ userId: "u1", body: { sessionId: "sess-1" } }), res);
    expect(res.statusCode).toBe(202);
    expect(res.jsonBody).toEqual({ interrupted: true });
    expect(interrupted).toEqual(["sess-1"]);
  });

  test("a non-owner is refused 403 and nothing is published", async () => {
    const bus = new Eventing();
    const interrupted: string[] = [];
    bus.subscribe(EXECUTION_INTERRUPT, (e) => interrupted.push((e.payload as { sessionId: string }).sessionId));
    const store = fakeStore(ownedSession("sess-1", "u1"));
    const router = createSessionApi(new SessionRegistry(), store, bus);
    const res = makeRes();
    await handlerFor(router, "post", "/session/interrupt")(makeReq({ userId: "attacker", body: { sessionId: "sess-1" } }), res);
    expect(res.statusCode).toBe(403);
    expect(interrupted).toEqual([]);
  });
});
