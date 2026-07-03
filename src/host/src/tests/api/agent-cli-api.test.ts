import { describe, expect, test } from "@jest/globals";
import { createAgentCliApi } from "../../api/agent-cli.js";
import type { AgentClient } from "../../comms/sender.js";
import type { WorkRecord } from "../../work/work-store.js";
import { routeFor, makeReq, makeRes, noopLogger, fakeWorks, workRecord } from "./doubles.js";

type CreateCall = { workspaceId: string; workId: string; subjectToken?: string | null; sessionId?: string };
type SessionCall = { sessionId: string; subjectToken?: string | null; input?: string };

// an AgentClient double recording every call so a test can assert the OBO subject token and session routing
function fakeAgent(overrides: Partial<AgentClient> = {}): AgentClient & {
  created: CreateCall[];
  inputs: SessionCall[];
  interrupted: SessionCall[];
} {
  const created: CreateCall[] = [];
  const inputs: SessionCall[] = [];
  const interrupted: SessionCall[] = [];
  return {
    created,
    inputs,
    interrupted,
    async createSession(workspaceId: string, workId: string, subjectToken?: string | null, sessionId?: string) {
      created.push({ workspaceId, workId, subjectToken, sessionId });
      return "sess-minted";
    },
    async closeSession() {},
    async openSseStream() {
      throw new Error("stream not wired in this test");
    },
    async sendInput(sessionId: string, input: string, subjectToken?: string | null) {
      inputs.push({ sessionId, input, subjectToken });
    },
    async interruptSession(sessionId: string, subjectToken?: string | null) {
      interrupted.push({ sessionId, subjectToken });
    },
    ...overrides,
  } as AgentClient & { created: CreateCall[]; inputs: SessionCall[]; interrupted: SessionCall[] };
}

function build(opts: { records?: WorkRecord[]; agent?: Partial<AgentClient> } = {}) {
  const agent = fakeAgent(opts.agent);
  const works = fakeWorks(opts.records ?? []);
  const router = createAgentCliApi(works, agent, noopLogger);
  return { router, agent, works };
}

// the canonical caller: owner u1 presenting the access token the routes must forward as the OBO subject
const asOwner = (params: Record<string, string>, body?: unknown) =>
  makeReq({ userId: "u1", accessToken: "tok-u1", params, body });

describe("agent-cli-api PUT /api/agent/cli/:workId", () => {
  test("404s another owner's work", async () => {
    const { router } = build({ records: [workRecord({ workId: "w1", userId: "someone-else" })] });
    const res = makeRes();
    await routeFor(router, "put", "/api/agent/cli/:workId")(asOwner({ workId: "w1" }), res);
    expect(res.statusCode).toBe(404);
  });

  test("409s while the work has no workspace to attach a session to", async () => {
    const { router } = build({ records: [workRecord({ workId: "w1", userId: "u1", workspaceId: null })] });
    const res = makeRes();
    await routeFor(router, "put", "/api/agent/cli/:workId")(asOwner({ workId: "w1" }), res);
    expect(res.statusCode).toBe(409);
  });

  test("409s a complete work — no new chat session on a locked work", async () => {
    const { router, agent } = build({ records: [workRecord({ workId: "w1", userId: "u1", status: "complete" })] });
    const res = makeRes();
    await routeFor(router, "put", "/api/agent/cli/:workId")(asOwner({ workId: "w1" }), res);
    expect(res.statusCode).toBe(409);
    expect(agent.created).toHaveLength(0);
  });

  test("mints the cli session under the USER's token and persists the binding", async () => {
    const { router, agent, works } = build({ records: [workRecord({ workId: "w1", userId: "u1" })] });
    const res = makeRes();
    await routeFor(router, "put", "/api/agent/cli/:workId")(asOwner({ workId: "w1" }), res);
    expect(res.jsonBody).toEqual({ sessionId: "sess-minted" });
    // the OBO subject is the caller's own token, so the agent owns the session by the user
    expect(agent.created).toEqual([{ workspaceId: "ws-1", workId: "w1", subjectToken: "tok-u1", sessionId: undefined }]);
    expect(works.cliSessions.get("w1")).toBe("sess-minted");
  });

  test("offers the cached session for reuse and stores whatever the agent resolves", async () => {
    const offered: (string | undefined)[] = [];
    const { router, works } = build({
      records: [workRecord({ workId: "w1", userId: "u1" })],
      agent: {
        createSession: async (_ws: string, _w: string, _tok?: string | null, sessionId?: string) => {
          offered.push(sessionId);
          return "sess-replacement";
        },
      },
    });
    works.cliSessions.set("w1", "sess-stale");
    const res = makeRes();
    await routeFor(router, "put", "/api/agent/cli/:workId")(asOwner({ workId: "w1" }), res);
    expect(res.jsonBody).toEqual({ sessionId: "sess-replacement" });
    expect(offered).toEqual(["sess-stale"]);
    // a now-invalid cached id is replaced rather than handed back to a doomed stream
    expect(works.cliSessions.get("w1")).toBe("sess-replacement");
  });
});

describe("agent-cli-api GET /api/agent/cli/:workId", () => {
  test("409s before the cli session is initialized", async () => {
    const { router } = build({ records: [workRecord({ workId: "w1", userId: "u1" })] });
    const res = makeRes();
    await routeFor(router, "get", "/api/agent/cli/:workId")(asOwner({ workId: "w1" }), res);
    expect(res.statusCode).toBe(409);
  });

  test("502s when the agent refuses the upstream stream", async () => {
    const { router, works } = build({
      records: [workRecord({ workId: "w1", userId: "u1" })],
      agent: { openSseStream: async () => ({ ok: false, status: 500 }) as unknown as Response },
    });
    works.cliSessions.set("w1", "sess-1");
    const res = makeRes();
    await routeFor(router, "get", "/api/agent/cli/:workId")(asOwner({ workId: "w1" }), res);
    expect(res.statusCode).toBe(502);
    expect(res.jsonBody).toEqual({ error: "agent /ssereceive -> 500" });
  });
});

describe("agent-cli-api POST /api/agent/cli/:workId/input", () => {
  test("409s a complete work even when a session lingers from before it completed", async () => {
    const { router, works } = build({ records: [workRecord({ workId: "w1", userId: "u1", status: "complete" })] });
    works.cliSessions.set("w1", "sess-1");
    const res = makeRes();
    await routeFor(router, "post", "/api/agent/cli/:workId/input")(asOwner({ workId: "w1" }, { input: "hi" }), res);
    expect(res.statusCode).toBe(409);
  });

  test("409s before the cli session is initialized", async () => {
    const { router } = build({ records: [workRecord({ workId: "w1", userId: "u1" })] });
    const res = makeRes();
    await routeFor(router, "post", "/api/agent/cli/:workId/input")(asOwner({ workId: "w1" }, { input: "hi" }), res);
    expect(res.statusCode).toBe(409);
  });

  test("400s a blank input", async () => {
    const { router, works } = build({ records: [workRecord({ workId: "w1", userId: "u1" })] });
    works.cliSessions.set("w1", "sess-1");
    const res = makeRes();
    await routeFor(router, "post", "/api/agent/cli/:workId/input")(asOwner({ workId: "w1" }, { input: "   " }), res);
    expect(res.statusCode).toBe(400);
  });

  test("202s, pushing the turn under the USER's token", async () => {
    const { router, agent, works } = build({ records: [workRecord({ workId: "w1", userId: "u1" })] });
    works.cliSessions.set("w1", "sess-1");
    const res = makeRes();
    await routeFor(router, "post", "/api/agent/cli/:workId/input")(asOwner({ workId: "w1" }, { input: " hello " }), res);
    expect(res.statusCode).toBe(202);
    expect(res.jsonBody).toEqual({ accepted: true });
    expect(agent.inputs).toEqual([{ sessionId: "sess-1", input: "hello", subjectToken: "tok-u1" }]);
  });

  test("502s when the agent rejects the turn", async () => {
    const { router, works } = build({
      records: [workRecord({ workId: "w1", userId: "u1" })],
      agent: {
        sendInput: async () => {
          throw new Error("agent /receive -> 500");
        },
      },
    });
    works.cliSessions.set("w1", "sess-1");
    const res = makeRes();
    await routeFor(router, "post", "/api/agent/cli/:workId/input")(asOwner({ workId: "w1" }, { input: "hi" }), res);
    expect(res.statusCode).toBe(502);
  });
});

describe("agent-cli-api POST /api/agent/cli/:workId/stop", () => {
  test("409s before the cli session is initialized", async () => {
    const { router } = build({ records: [workRecord({ workId: "w1", userId: "u1" })] });
    const res = makeRes();
    await routeFor(router, "post", "/api/agent/cli/:workId/stop")(asOwner({ workId: "w1" }), res);
    expect(res.statusCode).toBe(409);
  });

  test("202s, interrupting the live turn under the USER's token without closing the session", async () => {
    const { router, agent, works } = build({ records: [workRecord({ workId: "w1", userId: "u1" })] });
    works.cliSessions.set("w1", "sess-1");
    const res = makeRes();
    await routeFor(router, "post", "/api/agent/cli/:workId/stop")(asOwner({ workId: "w1" }), res);
    expect(res.statusCode).toBe(202);
    expect(res.jsonBody).toEqual({ stopped: true });
    expect(agent.interrupted).toEqual([{ sessionId: "sess-1", subjectToken: "tok-u1" }]);
    // stop interrupts the turn only; the binding must survive for the next input
    expect(works.cliSessions.get("w1")).toBe("sess-1");
  });
});
