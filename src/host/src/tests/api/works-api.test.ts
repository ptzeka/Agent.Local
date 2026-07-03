import { describe, expect, test } from "@jest/globals";
import type { DatabaseHandle } from "@agent-local/common/db";
import { createWorksApi } from "../../api/works.js";
import type { WorkService } from "../../services/work-service.js";
import type { WorkRecord } from "../../work/work-store.js";
import { routeFor, makeReq, makeRes, noopLogger, fakeWorks, workRecord } from "./doubles.js";

type WorksApiArgs = Parameters<typeof createWorksApi>;

// a WorkService double that records reconcile pings; each test overrides just the call it drives
function fakeService(overrides: Partial<WorkService> = {}): WorkService & { reconciled: string[] } {
  const reconciled: string[] = [];
  return {
    reconciled,
    requestReconcile: (workId: string) => reconciled.push(workId),
    ...overrides,
  } as unknown as WorkService & { reconciled: string[] };
}

// only the statuscodes route touches the db, and only via prepare().all()
function dbWith(rows: unknown[]): DatabaseHandle {
  return { prepare: () => ({ all: () => rows }) } as unknown as DatabaseHandle;
}

function build(opts: {
  service?: WorkService;
  records?: WorkRecord[];
  rows?: unknown[];
  workflows?: unknown[];
  getSteps?: (workId: string) => Promise<unknown>;
} = {}) {
  const service = opts.service ?? fakeService();
  const works = fakeWorks(opts.records ?? []);
  const router = createWorksApi(
    service,
    works,
    dbWith(opts.rows ?? []),
    (opts.workflows ?? []) as WorksApiArgs[3],
    noopLogger,
    (opts.getSteps ?? (async () => [])) as WorksApiArgs[5],
  );
  return { router, service: service as WorkService & { reconciled: string[] }, works };
}

// the create handler responds via .then, not await, so the test must let the microtask settle
const settled = () => new Promise(setImmediate);

describe("works-api authorization", () => {
  test("rejects 401 when the caller has no verified identity", async () => {
    const { router } = build();
    const res = makeRes();
    await routeFor(router, "get", "/api/works")(makeReq(), res);
    expect(res.statusCode).toBe(401);
  });

  test("rejects 403 when the identity lacks the required permission", async () => {
    const { router } = build();
    const res = makeRes();
    await routeFor(router, "get", "/api/works")(makeReq({ userId: "u1", permissions: ["something:else"] }), res);
    expect(res.statusCode).toBe(403);
  });
});

describe("works-api GET /api/works", () => {
  test("returns only the caller's works and reconciles each non-terminal one", async () => {
    const { router, service } = build({
      records: [
        workRecord({ workId: "w1", userId: "u1", status: "running" }),
        workRecord({ workId: "w2", userId: "u1", status: "complete" }),
        workRecord({ workId: "w3", userId: "someone-else" }),
      ],
    });
    const res = makeRes();
    await routeFor(router, "get", "/api/works")(makeReq({ userId: "u1" }), res);
    expect(res.statusCode).toBe(200);
    const works = (res.jsonBody as { works: WorkRecord[] }).works;
    expect(works.map((w) => w.workId)).toEqual(["w1", "w2"]);
    // a `complete` work is terminal and never pinged
    expect(service.reconciled).toEqual(["w1"]);
  });

  test("narrows by ?status=", async () => {
    const { router } = build({
      records: [
        workRecord({ workId: "w1", userId: "u1", status: "running" }),
        workRecord({ workId: "w2", userId: "u1", status: "attention" }),
      ],
    });
    const res = makeRes();
    await routeFor(router, "get", "/api/works")(makeReq({ userId: "u1", query: { status: "attention" } }), res);
    expect((res.jsonBody as { works: WorkRecord[] }).works.map((w) => w.workId)).toEqual(["w2"]);
  });
});

describe("works-api catalogs", () => {
  test("GET /api/works/workflows serves the injected template catalog", async () => {
    const workflows = [{ name: "demo", label: "Demo" }];
    const { router } = build({ workflows });
    const res = makeRes();
    await routeFor(router, "get", "/api/works/workflows")(makeReq({ userId: "u1" }), res);
    expect(res.jsonBody).toEqual({ workflows });
  });

  test("GET /api/works/statuscodes serves the db lookup with terminal mapped to a boolean", async () => {
    const { router } = build({ rows: [{ status: "complete", label: "Complete", tone: "success", terminal: 1 }] });
    const res = makeRes();
    await routeFor(router, "get", "/api/works/statuscodes")(makeReq({ userId: "u1" }), res);
    expect(res.jsonBody).toEqual({ statusCodes: [{ status: "complete", label: "Complete", tone: "success", terminal: true }] });
  });
});

describe("works-api GET /api/works/:workId", () => {
  test("404s an unknown work", async () => {
    const { router } = build();
    const res = makeRes();
    await routeFor(router, "get", "/api/works/:workId")(makeReq({ userId: "u1", params: { workId: "nope" } }), res);
    expect(res.statusCode).toBe(404);
  });

  test("404s another owner's work with the same body as an unknown one (no id leak)", async () => {
    const { router } = build({ records: [workRecord({ workId: "w1", userId: "someone-else" })] });
    const res = makeRes();
    await routeFor(router, "get", "/api/works/:workId")(makeReq({ userId: "u1", params: { workId: "w1" } }), res);
    expect(res.statusCode).toBe(404);
    expect(res.jsonBody).toEqual({ error: "unknown work" });
  });

  test("folds the engine step history in once the work has started", async () => {
    const record = workRecord({ workId: "w1", userId: "u1", temporalId: "w1" });
    const steps = [{ id: "s1", status: "completed" }];
    const { router, service } = build({ records: [record], getSteps: async () => steps });
    const res = makeRes();
    await routeFor(router, "get", "/api/works/:workId")(makeReq({ userId: "u1", params: { workId: "w1" } }), res);
    expect(res.jsonBody).toEqual({ work: record, steps, stepsError: null });
    expect(service.reconciled).toEqual(["w1"]);
  });

  test("skips the step read entirely while the work has no engine instance", async () => {
    let stepReads = 0;
    const { router } = build({
      records: [workRecord({ workId: "w1", userId: "u1", temporalId: null })],
      getSteps: async () => {
        stepReads += 1;
        return [];
      },
    });
    const res = makeRes();
    await routeFor(router, "get", "/api/works/:workId")(makeReq({ userId: "u1", params: { workId: "w1" } }), res);
    expect(stepReads).toBe(0);
    expect(res.jsonBody).toMatchObject({ steps: [], stepsError: null });
  });

  test("a Temporal outage degrades to empty steps plus the error, not a failed read", async () => {
    const { router } = build({
      records: [workRecord({ workId: "w1", userId: "u1", temporalId: "w1" })],
      getSteps: async () => {
        throw new Error("engine down");
      },
    });
    const res = makeRes();
    await routeFor(router, "get", "/api/works/:workId")(makeReq({ userId: "u1", params: { workId: "w1" } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody).toMatchObject({ steps: [], stepsError: expect.stringContaining("engine down") });
  });
});

describe("works-api POST /api/works", () => {
  test("202s with the workId, triggering under the caller's identity", async () => {
    const triggered: [string, string][] = [];
    const service = fakeService({
      trigger: async (workflowId: string, userId: string) => {
        triggered.push([workflowId, userId]);
        return "work-9";
      },
    });
    const { router } = build({ service });
    const res = makeRes();
    await routeFor(router, "post", "/api/works")(makeReq({ userId: "u1", body: { workflowId: "wf-a" } }), res);
    await settled();
    expect(res.statusCode).toBe(202);
    expect(res.jsonBody).toEqual({ workId: "work-9" });
    expect(triggered).toEqual([["wf-a", "u1"]]);
  });

  test("503s when the trigger fails", async () => {
    const service = fakeService({
      trigger: async () => {
        throw new Error("agent unreachable");
      },
    });
    const { router } = build({ service });
    const res = makeRes();
    await routeFor(router, "post", "/api/works")(makeReq({ userId: "u1", body: { workflowId: "wf-a" } }), res);
    await settled();
    expect(res.statusCode).toBe(503);
    expect(res.jsonBody).toMatchObject({ error: expect.stringContaining("agent unreachable") });
  });
});

describe("works-api POST /api/works/:workId/stop", () => {
  test("404s when the work is not the caller's", async () => {
    const service = fakeService({ stop: async () => null });
    const { router } = build({ service });
    const res = makeRes();
    await routeFor(router, "post", "/api/works/:workId/stop")(makeReq({ userId: "u1", params: { workId: "w1" } }), res);
    expect(res.statusCode).toBe(404);
  });

  test("stops the caller's work, forwarding the reason", async () => {
    const record = workRecord({ workId: "w1", userId: "u1" });
    const stops: [string, string, string][] = [];
    const service = fakeService({
      stop: async (workId: string, userId: string, reason: string) => {
        stops.push([workId, userId, reason]);
        return record;
      },
    });
    const { router } = build({ service });
    const res = makeRes();
    await routeFor(router, "post", "/api/works/:workId/stop")(
      makeReq({ userId: "u1", params: { workId: "w1" }, body: { reason: "operator said so" } }),
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody).toEqual({ work: record });
    expect(stops).toEqual([["w1", "u1", "operator said so"]]);
  });
});

describe("works-api POST /api/works/:workId/continue", () => {
  test("maps the service's null / false / record answers to 404 / 409 / 202", async () => {
    const record = workRecord({ workId: "w1", userId: "u1", status: "running" });
    const answers: (null | false | WorkRecord)[] = [null, false, record];
    const service = fakeService({ continue: async () => answers.shift() ?? null });
    const { router } = build({ service });
    const drive = routeFor(router, "post", "/api/works/:workId/continue");

    for (const expected of [404, 409, 202]) {
      const res = makeRes();
      await drive(makeReq({ userId: "u1", params: { workId: "w1" } }), res);
      expect(res.statusCode).toBe(expected);
    }
  });
});

describe("works-api POST /api/works/:workId/inject", () => {
  test("409s while the instance has not started", async () => {
    const service = fakeService({ inject: async () => false });
    const { router } = build({ service });
    const res = makeRes();
    await routeFor(router, "post", "/api/works/:workId/inject")(
      makeReq({ userId: "u1", params: { workId: "w1" }, body: { variables: { a: 1 } } }),
      res,
    );
    expect(res.statusCode).toBe(409);
  });

  test("202s, forwarding variables and scope options", async () => {
    const record = workRecord({ workId: "w1", userId: "u1" });
    const injected: unknown[] = [];
    const service = fakeService({
      inject: async (workId: string, userId: string, variables: Record<string, unknown>, opts?: unknown) => {
        injected.push([workId, userId, variables, opts]);
        return record;
      },
    });
    const { router } = build({ service });
    const res = makeRes();
    await routeFor(router, "post", "/api/works/:workId/inject")(
      makeReq({ userId: "u1", params: { workId: "w1" }, body: { variables: { a: 1 }, scopeKey: "sk", local: true } }),
      res,
    );
    expect(res.statusCode).toBe(202);
    expect(injected).toEqual([["w1", "u1", { a: 1 }, { scopeKey: "sk", local: true }]]);
  });
});

describe("works-api POST /api/works/:workId/retry", () => {
  test("400s without a jobKey", async () => {
    const { router } = build();
    const res = makeRes();
    await routeFor(router, "post", "/api/works/:workId/retry")(
      makeReq({ userId: "u1", params: { workId: "w1" }, body: {} }),
      res,
    );
    expect(res.statusCode).toBe(400);
  });

  test("202s, forwarding the jobKey and retry options", async () => {
    const record = workRecord({ workId: "w1", userId: "u1" });
    const retried: unknown[] = [];
    const service = fakeService({
      retryStep: async (workId: string, userId: string, jobKey: string, opts?: unknown) => {
        retried.push([workId, userId, jobKey, opts]);
        return record;
      },
    });
    const { router } = build({ service });
    const res = makeRes();
    await routeFor(router, "post", "/api/works/:workId/retry")(
      makeReq({ userId: "u1", params: { workId: "w1" }, body: { jobKey: "jk-1", retries: 2 } }),
      res,
    );
    expect(res.statusCode).toBe(202);
    expect(retried).toEqual([["w1", "u1", "jk-1", { incidentKey: undefined, retries: 2 }]]);
  });
});

describe("works-api POST /api/works/:workId/steps/:stepId/rerun", () => {
  test("202s, rerunning from the addressed step", async () => {
    const record = workRecord({ workId: "w1", userId: "u1" });
    const reruns: [string, string, string][] = [];
    const service = fakeService({
      rerunStep: async (workId: string, userId: string, stepId: string) => {
        reruns.push([workId, userId, stepId]);
        return record;
      },
    });
    const { router } = build({ service });
    const res = makeRes();
    await routeFor(router, "post", "/api/works/:workId/steps/:stepId/rerun")(
      makeReq({ userId: "u1", params: { workId: "w1", stepId: "s2" } }),
      res,
    );
    expect(res.statusCode).toBe(202);
    expect(reruns).toEqual([["w1", "u1", "s2"]]);
  });
});
