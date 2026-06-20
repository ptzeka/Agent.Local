import { describe, it, expect } from "@jest/globals";
// import from the eventing subpath, not the index: the index transitively pulls jwt -> jose (ESM-only),
// which ts-jest's commonjs transform cannot load. eventing.ts has no such dependency.
import { Eventing, type EventMessage } from "@agent-local/common/eventing";
import { TemporalClient, WorkflowDisabledError, type TemporalCore, type ExecutionStatus } from "../temporal-client.js";
import { loadConfig } from "../config.js";

const noopLogger = { error() {}, warn() {}, info() {}, debug() {} };

// a fake core that records every call so a test can assert routing without a Temporal server
function fakeCore(): {
  core: TemporalCore;
  started: { workflowType: string; workflowId: string }[];
  cancelled: string[];
  signals: { workflowId: string; name: string; payload: Record<string, unknown> }[];
  setStatus: (s: ExecutionStatus) => void;
} {
  const started: { workflowType: string; workflowId: string }[] = [];
  const cancelled: string[] = [];
  const signals: { workflowId: string; name: string; payload: Record<string, unknown> }[] = [];
  let status: ExecutionStatus = "running";
  const core: TemporalCore = {
    async connect() {},
    async start({ workflowType, workflowId }) {
      started.push({ workflowType, workflowId });
      return { runId: "RUN-1" };
    },
    async describe() {
      return { runId: "RUN-1", workflowType: "agentExecuteWorkflow", status };
    },
    async cancel(workflowId) {
      cancelled.push(workflowId);
    },
    async terminate() {},
    async result() {
      // a never-settling watcher keeps these unit tests focused on routing, not terminal folding
      return new Promise<never>(() => {});
    },
    async signal(req) {
      signals.push(req);
    },
    async query() {
      return undefined as never;
    },
    async close() {},
  };
  return { core, started, cancelled, signals, setStatus: (s) => (status = s) };
}

function captured(bus: Eventing): EventMessage[] {
  const events: EventMessage[] = [];
  bus.subscribe((e) => events.push(e));
  return events;
}

describe("TemporalClient", () => {
  it("startProcess uses our workId as the Temporal WorkflowId and reflects the run", async () => {
    const bus = new Eventing();
    const { core, started } = fakeCore();
    const client = new TemporalClient(loadConfig(), bus, noopLogger, new AbortController().signal, core);
    const rec = await client.startProcess("agentExecuteWorkflow", "WORK-7", { foo: "bar" });

    expect(started).toEqual([{ workflowType: "agentExecuteWorkflow", workflowId: "WORK-7" }]);
    expect(rec.workflowId).toBe("WORK-7");
    expect(rec.runId).toBe("RUN-1");
    expect(rec.status).toBe("running");
  });

  it("getInstance reads authoritative state from describe(), holding no local map", async () => {
    const bus = new Eventing();
    const { core, setStatus } = fakeCore();
    const client = new TemporalClient(loadConfig(), bus, noopLogger, new AbortController().signal, core);
    // never started locally — getInstance still resolves because Temporal's visibility is the source of truth
    setStatus("completed");
    const rec = await client.getInstance("WORK-7");
    expect(rec?.status).toBe("completed");
    expect(rec?.runId).toBe("RUN-1");
  });

  it("reportResult signals agentResult and does NOT publish workflow.completed (workflow decides done/next)", async () => {
    const bus = new Eventing();
    const events = captured(bus);
    const { core, signals } = fakeCore();
    const client = new TemporalClient(loadConfig(), bus, noopLogger, new AbortController().signal, core);

    await client.reportResult("WORK-7", { answer: 42 });

    expect(signals).toEqual([{ workflowId: "WORK-7", name: "agentResult", payload: { result: { answer: 42 } } }]);
    expect(events.find((e) => e.type === "workflow.completed")).toBeUndefined();
  });

  it("setVariables injects via an inject signal", async () => {
    const bus = new Eventing();
    const { core, signals } = fakeCore();
    const client = new TemporalClient(loadConfig(), bus, noopLogger, new AbortController().signal, core);

    await client.setVariables("WORK-7", { approved: true });

    expect(signals).toEqual([{ workflowId: "WORK-7", name: "inject", payload: { approved: true } }]);
  });

  it("cancelProcess routes to the handle cancel", async () => {
    const bus = new Eventing();
    const { core, cancelled } = fakeCore();
    const client = new TemporalClient(loadConfig(), bus, noopLogger, new AbortController().signal, core);
    await client.cancelProcess("WORK-7");
    expect(cancelled).toEqual(["WORK-7"]);
  });

  it("does not crash when the server is down at boot", async () => {
    const bus = new Eventing();
    const { core } = fakeCore();
    core.connect = async () => {
      throw new Error("server down");
    };
    const client = new TemporalClient(loadConfig(), bus, noopLogger, new AbortController().signal, core);
    await expect(client.start()).resolves.toBeUndefined();
    expect(client.connected).toBe(false);
    await client.stop();
  });

  it("startProcess refuses a workflow type outside a populated allowlist", async () => {
    const bus = new Eventing();
    const { core } = fakeCore();
    const cfg = { ...loadConfig(), enabledWorkflowTypes: ["only-this"] };
    const client = new TemporalClient(cfg, bus, noopLogger, new AbortController().signal, core);
    await expect(client.startProcess("agentExecuteWorkflow", "WORK-7", {})).rejects.toBeInstanceOf(WorkflowDisabledError);
    const allowed = await client.startProcess("only-this", "WORK-8", {});
    expect(allowed.workflowId).toBe("WORK-8");
  });
});
