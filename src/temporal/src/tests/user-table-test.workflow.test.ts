import { describe, it, expect, jest, beforeAll, afterAll } from "@jest/globals";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import {
  userTableTestWorkflow,
  agentResultSignal,
  USER_TABLE_TEST_WORKFLOW_TYPE,
} from "../workflows/user-table-test.js";
import type { DispatchAgentTaskInput } from "../workflows/activities.js";

// time-skipping env + the real workflow code, with the agent dispatch MOCKED — the test plays the agent's part
// by signaling agentResult, so it proves the 5-step orchestration end-to-end with no bus, agent, or live server.
describe("userTableTestWorkflow", () => {
  let env: TestWorkflowEnvironment;

  beforeAll(async () => {
    env = await TestWorkflowEnvironment.createTimeSkipping();
  });

  afterAll(async () => {
    await env?.teardown();
  });

  it("drives create -> add -> assert and returns the terminal message", async () => {
    const dispatched: DispatchAgentTaskInput[] = [];
    // play the agent: each dispatch immediately signals its answer back, so request/response is deterministic
    // under time skipping (no racing the clock with out-of-band signals from the test body)
    const dispatchAgentTask = jest.fn(async (input: DispatchAgentTaskInput) => {
      dispatched.push(input);
      const handle = env.client.workflow.getHandle(input.workId);
      await handle.signal(agentResultSignal, { result: `answered: ${input.prompt.slice(0, 16)}` });
    });

    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: "test",
      workflowsPath: require.resolve("../workflows/user-table-test.js"),
      activities: { dispatchAgentTask },
    });

    const result = await worker.runUntil(
      env.client.workflow.execute(userTableTestWorkflow, {
        taskQueue: "test",
        workflowId: "WORK-1",
        args: [{ workId: "WORK-1", workspaceId: "WS-1", sessionId: "SESS-1" }],
      }),
    );

    expect(result).toBe("user table created");
    // step 1 (initialize) runs no agent turn; steps 2-4 each dispatch exactly one prompt
    expect(dispatched).toHaveLength(3);
    expect(dispatched[0].prompt).toContain("Create an Excel sheet");
    expect(dispatched[1].prompt).toContain("userId=55, userName=foxmulder");
    expect(dispatched[2].prompt).toContain("Verify");
    expect(dispatched.every((d) => d.sessionId === "SESS-1")).toBe(true);
  });

  it("fails the workflow when a step's agent turn reports a non-satisfied outcome", async () => {
    const dispatched: DispatchAgentTaskInput[] = [];
    // play the agent: the FIRST step (create) reports a failure verdict, so the workflow must throw on that step
    // and never dispatch the remaining ones — proving a false `completed` can no longer ride past a failed turn
    const dispatchAgentTask = jest.fn(async (input: DispatchAgentTaskInput) => {
      dispatched.push(input);
      const handle = env.client.workflow.getHandle(input.workId);
      await handle.signal(agentResultSignal, {
        result: "SYSTEM-FAILURE: failed to complete request — executor produced no tool call",
        outcome: "failed",
      });
    });

    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: "test",
      workflowsPath: require.resolve("../workflows/user-table-test.js"),
      activities: { dispatchAgentTask },
    });

    // Temporal wraps the workflow's ApplicationFailure in a WorkflowFailedError; the verdict rides on .cause
    const failure = await worker
      .runUntil(
        env.client.workflow.execute(userTableTestWorkflow, {
          taskQueue: "test",
          workflowId: "WORK-FAIL",
          args: [{ workId: "WORK-FAIL", workspaceId: "WS-2", sessionId: "SESS-2" }],
        }),
      )
      .then(() => null)
      .catch((err: unknown) => err as Error & { cause?: Error });

    expect(failure).not.toBeNull();
    expect((failure?.cause as Error)?.message).toMatch(/outcome: failed/);

    // only the first step dispatched; the failure short-circuits the rest
    expect(dispatched).toHaveLength(1);
  });

  it("exports a stable workflow type string for the host to start it by", () => {
    expect(USER_TABLE_TEST_WORKFLOW_TYPE).toBe("userTableTestWorkflow");
  });
});
