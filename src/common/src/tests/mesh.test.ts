import { describe, expect, test } from "@jest/globals";

import { Eventing } from "../eventing.js";
import {
  wireCamundaMesh,
  WORKFLOW_JOB,
  WORKFLOW_COMPLETED,
  WORKFLOW_FAILED,
  AGENT_JOB,
  type CorrelatedJob,
} from "../mesh.js";

// Camunda always initiates: a workflow.job event drives a correlated dispatch to the agent seam.
describe("wireCamundaMesh", () => {
  test("a workflow.job correlates to a sessionId and routes to the dispatch seam", () => {
    const bus = new Eventing();
    const dispatched: CorrelatedJob[] = [];
    wireCamundaMesh(bus, { dispatchToAgent: (job) => dispatched.push(job) });

    bus.publish(WORKFLOW_JOB, {
      processInstanceKey: "pi-1",
      jobKey: "job-1",
      jobType: "review",
      variables: { path: "x.ts" },
    });

    expect(dispatched).toEqual([
      {
        processInstanceKey: "pi-1",
        jobKey: "job-1",
        jobType: "review",
        variables: { path: "x.ts" },
        sessionId: "pi:pi-1",
      },
    ]);
  });

  test("two jobs of the same process instance share one session", () => {
    const bus = new Eventing();
    const sessions: string[] = [];
    wireCamundaMesh(bus, { dispatchToAgent: (j) => sessions.push(j.sessionId) });

    bus.publish(WORKFLOW_JOB, { processInstanceKey: "pi-1", jobKey: "job-1", jobType: "a", variables: {} });
    bus.publish(WORKFLOW_JOB, { processInstanceKey: "pi-1", jobKey: "job-2", jobType: "b", variables: {} });

    expect(sessions).toEqual(["pi:pi-1", "pi:pi-1"]);
  });

  test("an injected sessionIdFor overrides the default correlation", () => {
    const bus = new Eventing();
    const sessions: string[] = [];
    wireCamundaMesh(bus, {
      dispatchToAgent: (j) => sessions.push(j.sessionId),
      sessionIdFor: (j) => `sess-${j.jobKey}`,
    });

    bus.publish(WORKFLOW_JOB, { processInstanceKey: "pi-1", jobKey: "job-9", jobType: "a", variables: {} });

    expect(sessions).toEqual(["sess-job-9"]);
  });

  test("unsubscribe stops further dispatch", () => {
    const bus = new Eventing();
    const sessions: string[] = [];
    const off = wireCamundaMesh(bus, { dispatchToAgent: (j) => sessions.push(j.sessionId) });

    off();
    bus.publish(WORKFLOW_JOB, { processInstanceKey: "pi-1", jobKey: "job-1", jobType: "a", variables: {} });

    expect(sessions).toEqual([]);
  });

  test("the default seam re-publishes the correlated job as agent.job on the bus", () => {
    const bus = new Eventing();
    const agentJobs: CorrelatedJob[] = [];
    bus.subscribe(AGENT_JOB, (e) => agentJobs.push(e.payload as unknown as CorrelatedJob));
    wireCamundaMesh(bus);

    bus.publish(WORKFLOW_JOB, { processInstanceKey: "pi-1", jobKey: "job-1", jobType: "a", variables: { x: 1 } });

    expect(agentJobs).toEqual([
      { processInstanceKey: "pi-1", jobKey: "job-1", jobType: "a", variables: { x: 1 }, sessionId: "pi:pi-1" },
    ]);
  });

  test("workflow.completed and workflow.failed are observed without dispatching", () => {
    const bus = new Eventing();
    const sessions: string[] = [];
    wireCamundaMesh(bus, { dispatchToAgent: (j) => sessions.push(j.sessionId) });

    bus.publish(WORKFLOW_COMPLETED, { processInstanceKey: "pi-1" });
    bus.publish(WORKFLOW_FAILED, { processInstanceKey: "pi-1", jobKey: "job-1", error: "boom" });

    expect(sessions).toEqual([]);
  });
});
