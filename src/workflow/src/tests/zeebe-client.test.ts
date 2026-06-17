import { describe, it, expect } from "@jest/globals";
import { Eventing, type EventMessage } from "@agent-local/common";
import { ZeebeClient, type ZeebeGrpc } from "../zeebe-client.js";
import { loadConfig } from "../config.js";

const noopLogger = { error() {}, warn() {}, info() {}, debug() {} };

// a fake gRPC that captures the registered worker handler so a test can drive a job without a broker
function fakeGrpc(): { grpc: ZeebeGrpc; activate: (job: any) => Promise<unknown>; completed: any[] } {
  let handler: (job: any) => Promise<unknown> = async () => undefined;
  const completed: any[] = [];
  const grpc: ZeebeGrpc = {
    async topology() {},
    async deployResource() {},
    async createProcessInstance({ bpmnProcessId }) {
      return { processInstanceKey: "PI-1", bpmnProcessId } as any;
    },
    createWorker(cfg) {
      handler = cfg.taskHandler;
      return { async close() {} };
    },
    async completeJob(req) {
      completed.push(req);
    },
    async close() {},
  };
  return { grpc, activate: (job) => handler(job), completed };
}

function captured(bus: Eventing): EventMessage[] {
  const events: EventMessage[] = [];
  bus.subscribe((e) => events.push(e));
  return events;
}

describe("ZeebeClient", () => {
  it("publishes workflow.job with the exact payload when a job activates", async () => {
    const bus = new Eventing();
    const events = captured(bus);
    const { grpc, activate } = fakeGrpc();
    const client = new ZeebeClient(loadConfig(), bus, noopLogger, new AbortController().signal, grpc);
    await client.start();

    await activate({
      key: "JOB-9",
      type: "agent-execute",
      processInstanceKey: "PI-1",
      variables: { foo: "bar" },
      forward: () => "forwarded",
    });

    const job = events.find((e) => e.type === "workflow.job");
    expect(job?.payload).toEqual({
      processInstanceKey: "PI-1",
      jobKey: "JOB-9",
      jobType: "agent-execute",
      variables: { foo: "bar" },
    });
  });

  it("completeJob calls the broker and publishes workflow.completed", async () => {
    const bus = new Eventing();
    const events = captured(bus);
    const { grpc, completed } = fakeGrpc();
    const client = new ZeebeClient(loadConfig(), bus, noopLogger, new AbortController().signal, grpc);
    await client.start();

    await client.completeJob("JOB-9", { processInstanceKey: "PI-1", result: "ok" });

    expect(completed).toEqual([{ jobKey: "JOB-9", variables: { processInstanceKey: "PI-1", result: "ok" } }]);
    expect(events.find((e) => e.type === "workflow.completed")?.payload).toEqual({ processInstanceKey: "PI-1" });
  });

  it("does not crash when the broker is down at boot", async () => {
    const bus = new Eventing();
    const { grpc } = fakeGrpc();
    grpc.topology = async () => {
      throw new Error("broker down");
    };
    const client = new ZeebeClient(loadConfig(), bus, noopLogger, new AbortController().signal, grpc);
    await expect(client.start()).resolves.toBeUndefined();
    expect(client.connected).toBe(false);
    await client.stop();
  });

  it("startProcess records an instance reflected by getInstance", async () => {
    const bus = new Eventing();
    const { grpc } = fakeGrpc();
    const client = new ZeebeClient(loadConfig(), bus, noopLogger, new AbortController().signal, grpc);
    const rec = await client.startProcess("agent-execute-process", {});
    expect(rec.processInstanceKey).toBe("PI-1");
    expect(client.getInstance("PI-1")?.status).toBe("active");
  });
});
