import { describe, expect, test } from "@jest/globals";
import type { Request, Response } from "express";
import { Container } from "@agent-local/common/container";
import { Eventing } from "@agent-local/common/eventing";
import { HttpReceiver } from "../../src/server/comms/receiver.js";
import { EXECUTION_REQUESTED, type ExecutionRequested } from "../../src/server/comms/contract.js";
import { LOGGER, SERVER_CONFIG } from "../../src/server/container-tokens.js";
import type { AgentServerSettings } from "../../src/server/appsettings.js";

// reach the POST /receive handler out of the express router so the test drives it with a fake req/res, no HTTP
function receiveHandler(): (req: Request, res: Response) => void {
  const router = new HttpReceiver().routes() as unknown as {
    stack: { route?: { path: string; stack: { handle: (req: Request, res: Response) => void }[] } }[];
  };
  const layer = router.stack.find((l) => l.route?.path === "/receive");
  if (!layer?.route) throw new Error("POST /receive not mounted");
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function settings(required: boolean): AgentServerSettings {
  return { authentication: { scheme: "bearer", required, tokenEnv: "AGENT_API_TOKEN" } } as AgentServerSettings;
}

// minimal req: the receiver reads container (logger/config/bus), the session header, body, and userContext
function makeReq(opts: {
  bus: Eventing;
  required: boolean;
  authenticated: boolean;
  body: unknown;
  sessionId?: string;
  serviceId?: string;
}): Request {
  const container = new Container();
  container.set(LOGGER, { debug: () => {}, error: () => {} } as never);
  container.set(SERVER_CONFIG, settings(opts.required));
  container.set(Eventing, opts.bus);
  return {
    container,
    body: opts.body,
    header: (name: string) => (name.toLowerCase() === "x-session-id" ? opts.sessionId : undefined),
    userContext: {
      accessToken: null,
      permissions: ["agent:trigger"],
      authenticated: opts.authenticated,
      userInfo: opts.serviceId ? { serviceId: opts.serviceId } : null,
    },
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

describe("HttpReceiver", () => {
  test("a valid request publishes one EXECUTION_REQUESTED and ACKs 202 without running a turn", () => {
    const bus = new Eventing();
    const seen: ExecutionRequested[] = [];
    bus.subscribe(EXECUTION_REQUESTED, (e) => seen.push(e.payload as unknown as ExecutionRequested));

    const handler = receiveHandler();
    const res = makeRes();
    handler(
      makeReq({
        bus,
        required: true,
        authenticated: true,
        serviceId: "agentic-client-dev",
        sessionId: "sess-1",
        body: { runId: "work-1", input: "  do the thing  " },
      }),
      res,
    );

    expect(res.statusCode).toBe(202);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      sessionId: "sess-1",
      runId: "work-1",
      input: "do the thing",
      source: "agentic-client-dev",
    });
    expect(typeof seen[0].createdAt).toBe("string");
    // no engine vocabulary leaks onto the internal event
    expect(seen[0]).not.toHaveProperty("temporalId");
    expect(seen[0]).not.toHaveProperty("jobKey");
    expect(seen[0]).not.toHaveProperty("eventType");
  });

  test("an unauthenticated request is rejected 401 when enforcement is on and nothing is published", () => {
    const bus = new Eventing();
    let published = 0;
    bus.subscribe(EXECUTION_REQUESTED, () => (published += 1));

    const res = makeRes();
    receiveHandler()(
      makeReq({ bus, required: true, authenticated: false, body: { runId: "w", input: "x" } }),
      res,
    );

    expect(res.statusCode).toBe(401);
    expect(published).toBe(0);
  });

  test("a request missing input is rejected 400 and nothing is published", () => {
    const bus = new Eventing();
    let published = 0;
    bus.subscribe(EXECUTION_REQUESTED, () => (published += 1));

    const res = makeRes();
    receiveHandler()(
      makeReq({ bus, required: true, authenticated: true, serviceId: "svc", body: { runId: "w" } }),
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(published).toBe(0);
  });
});
