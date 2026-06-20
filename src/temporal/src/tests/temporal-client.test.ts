import { describe, it, expect } from "@jest/globals";
// import from the eventing subpath, not the index: the index transitively pulls jwt -> jose (ESM-only),
// which ts-jest's commonjs transform cannot load. eventing.ts has no such dependency.
import { Eventing, type EventMessage } from "@agent-local/common/eventing";
import { TemporalClient, WorkflowDisabledError, type TemporalCore, type ExecutionStatus, type HistoryEvent } from "../temporal-client.js";
import { loadConfig } from "../config.js";

const noopLogger = { error() {}, warn() {}, info() {}, debug() {} };

// a fake core that records every call so a test can assert routing without a Temporal server
function fakeCore(): {
  core: TemporalCore;
  started: { workflowType: string; workflowId: string }[];
  cancelled: string[];
  signals: { workflowId: string; name: string; payload: Record<string, unknown> }[];
  resets: { workflowId: string; stepId: string; reason: string }[];
  setStatus: (s: ExecutionStatus) => void;
  setEvents: (e: HistoryEvent[]) => void;
} {
  const started: { workflowType: string; workflowId: string }[] = [];
  const cancelled: string[] = [];
  const signals: { workflowId: string; name: string; payload: Record<string, unknown> }[] = [];
  const resets: { workflowId: string; stepId: string; reason: string }[] = [];
  let status: ExecutionStatus = "running";
  let events: HistoryEvent[] = [];
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
    async history() {
      return events;
    },
    async resetToStep(workflowId, stepId, reason) {
      resets.push({ workflowId, stepId, reason });
      return { runId: "RUN-2" };
    },
    async close() {},
  };
  return {
    core,
    started,
    cancelled,
    signals,
    resets,
    setStatus: (s) => (status = s),
    setEvents: (e: HistoryEvent[]) => (events = e),
  };
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

  it("getSteps folds activity events into one step per invocation, latest event setting the status", async () => {
    const bus = new Eventing();
    const { core, setEvents } = fakeCore();
    const client = new TemporalClient(loadConfig(), bus, noopLogger, new AbortController().signal, core);
    // two activity invocations: step 5 ran to completion, step 8 is still only scheduled (order by schedule time)
    setEvents([
      { eventId: "5", type: "ActivityTaskScheduled", timestamp: "2026-06-19T10:00:00.000Z", activityType: "dispatchAgentTask", summary: "Create the users sheet" },
      { eventId: "6", type: "ActivityTaskStarted", timestamp: "2026-06-19T10:00:01.000Z", scheduledEventId: "5" },
      { eventId: "7", type: "ActivityTaskCompleted", timestamp: "2026-06-19T10:00:05.000Z", scheduledEventId: "5" },
      { eventId: "8", type: "ActivityTaskScheduled", timestamp: "2026-06-19T10:00:06.000Z", activityType: "dispatchAgentTask" },
    ]);

    const steps = await client.getSteps("WORK-7");

    expect(steps.map((s) => ({ id: s.id, status: s.status, description: s.description }))).toEqual([
      { id: "5", status: "completed", description: "Create the users sheet" },
      { id: "8", status: "scheduled", description: null },
    ]);
  });

  it("getSteps keeps a failed activity's failure message as the step detail", async () => {
    const bus = new Eventing();
    const { core, setEvents } = fakeCore();
    const client = new TemporalClient(loadConfig(), bus, noopLogger, new AbortController().signal, core);
    setEvents([
      { eventId: "5", type: "ActivityTaskScheduled", timestamp: "2026-06-19T10:00:00.000Z", activityType: "dispatchAgentTask" },
      { eventId: "6", type: "ActivityTaskFailed", timestamp: "2026-06-19T10:00:02.000Z", scheduledEventId: "5", detail: "boom" },
    ]);

    const [step] = await client.getSteps("WORK-7");

    expect(step.status).toBe("failed");
    expect(step.detail).toBe("boom");
  });

  it("rerunFromStep routes to the core reset-to-step with the chosen step id", async () => {
    const bus = new Eventing();
    const { core, resets } = fakeCore();
    const client = new TemporalClient(loadConfig(), bus, noopLogger, new AbortController().signal, core);

    await client.rerunFromStep("WORK-7", "5");

    expect(resets).toEqual([{ workflowId: "WORK-7", stepId: "5", reason: "rerun from step" }]);
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
