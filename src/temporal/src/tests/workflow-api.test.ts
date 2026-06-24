import { describe, it, expect } from "@jest/globals";
import type { Request, Response, Router } from "express";
import { createWorkflowApi } from "../api/workflow-api.js";
import { TemporalClient, WorkflowDisabledError, type ExecutionRecord } from "../temporal-client.js";
import { loadConfig } from "../config.js";

// reach a route handler out of the express Router so the test drives it with a fake req/res, no HTTP listener
function handlerFor(router: Router, method: string, path: string): (req: Request, res: Response) => unknown {
  const stack = (router as unknown as {
    stack: { route?: { path: string; methods: Record<string, boolean>; stack: { handle: (req: Request, res: Response) => unknown }[] } }[];
  }).stack;
  const layer = stack.find((l) => l.route?.path === path && l.route?.methods[method]);
  if (!layer?.route) throw new Error(`${method.toUpperCase()} ${path} not mounted`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

const record = (workflowId: string): ExecutionRecord => ({
  workflowId,
  runId: "RUN-1",
  workflowType: "agentExecuteWorkflow",
  status: "running",
  startedAt: 0,
});

// a stand-in for the TemporalClient with only the surface the routes touch; the real client needs a live server
function fakeClient(over: Partial<Pick<TemporalClient, "startProcess" | "getInstance">> & { connected?: boolean }): TemporalClient {
  return {
    connected: over.connected ?? true,
    startProcess: over.startProcess ?? (async (_t, workId) => record(workId)),
    getInstance: over.getInstance ?? (async () => undefined),
  } as unknown as TemporalClient;
}

function makeReq(opts: { body?: unknown; params?: Record<string, string> }): Request {
  return { body: opts.body ?? {}, params: opts.params ?? {} } as unknown as Request;
}

// the route handlers chain off a promise and answer via res.json; `done` resolves once they do, so a test can await it
function makeRes(): Response & { statusCode: number; jsonBody: unknown; done: Promise<void> } {
  let settle: () => void;
  const done = new Promise<void>((resolve) => (settle = resolve));
  const res = {
    statusCode: 0,
    jsonBody: undefined as unknown,
    done,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.jsonBody = body;
      settle();
      return this;
    },
  };
  return res as unknown as Response & { statusCode: number; jsonBody: unknown; done: Promise<void> };
}

const config = loadConfig({});

describe("workflow-api POST /workflow/process", () => {
  it("starts the workflow with the caller's workId and answers 201 with the record", async () => {
    const started: string[] = [];
    const client = fakeClient({
      startProcess: async (_type, workId) => {
        started.push(workId);
        return record(workId);
      },
    });
    const res = makeRes();
    handlerFor(createWorkflowApi(client, config), "post", "/workflow/process")(
      makeReq({ body: { workId: "work-1" } }),
      res,
    );
    await res.done;
    expect(res.statusCode).toBe(201);
    expect(started).toEqual(["work-1"]);
    expect(res.jsonBody).toMatchObject({ workflowId: "work-1" });
  });

  it("mints a workId when the caller omits one", async () => {
    const started: string[] = [];
    const client = fakeClient({
      startProcess: async (_type, workId) => {
        started.push(workId);
        return record(workId);
      },
    });
    const res = makeRes();
    handlerFor(createWorkflowApi(client, config), "post", "/workflow/process")(makeReq({ body: {} }), res);
    await res.done;
    expect(res.statusCode).toBe(201);
    expect(started[0]).toBeTruthy();
  });

  it("maps a disabled workflow to 403 (a client refusal, not a 503 outage)", async () => {
    const client = fakeClient({
      startProcess: async () => {
        throw new WorkflowDisabledError("nope");
      },
    });
    const res = makeRes();
    handlerFor(createWorkflowApi(client, config), "post", "/workflow/process")(
      makeReq({ body: { workflowType: "nope" } }),
      res,
    );
    await res.done;
    expect(res.statusCode).toBe(403);
  });

  it("maps any other start failure to 503", async () => {
    const client = fakeClient({
      startProcess: async () => {
        throw new Error("server down");
      },
    });
    const res = makeRes();
    handlerFor(createWorkflowApi(client, config), "post", "/workflow/process")(makeReq({ body: {} }), res);
    await res.done;
    expect(res.statusCode).toBe(503);
  });
});

describe("workflow-api GET /workflow/process/:key", () => {
  it("answers 200 with the record when the execution exists", async () => {
    const client = fakeClient({ getInstance: async (key) => record(key) });
    const res = makeRes();
    handlerFor(createWorkflowApi(client, config), "get", "/workflow/process/:key")(
      makeReq({ params: { key: "work-1" } }),
      res,
    );
    await res.done;
    expect(res.statusCode).toBe(0); // res.json without an explicit status() leaves express's default 200
    expect(res.jsonBody).toMatchObject({ workflowId: "work-1" });
  });

  it("answers 404 when the execution is unknown", async () => {
    const client = fakeClient({ getInstance: async () => undefined });
    const res = makeRes();
    handlerFor(createWorkflowApi(client, config), "get", "/workflow/process/:key")(
      makeReq({ params: { key: "ghost" } }),
      res,
    );
    await res.done;
    expect(res.statusCode).toBe(404);
  });
});

describe("workflow-api GET /workflow/healthz", () => {
  it("answers 200 when the client is connected", async () => {
    const res = makeRes();
    handlerFor(createWorkflowApi(fakeClient({ connected: true }), config), "get", "/workflow/healthz")(makeReq({}), res);
    await res.done;
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody).toMatchObject({ connected: true });
  });

  it("answers 503 when the client is disconnected", async () => {
    const res = makeRes();
    handlerFor(createWorkflowApi(fakeClient({ connected: false }), config), "get", "/workflow/healthz")(makeReq({}), res);
    await res.done;
    expect(res.statusCode).toBe(503);
  });
});
