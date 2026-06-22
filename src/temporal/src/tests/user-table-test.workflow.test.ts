import { describe, it, expect, jest, beforeAll, afterAll } from "@jest/globals";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import {
  userTableTestWorkflow,
  userTableFailTestWorkflow,
  agentResultSignal,
  USER_TABLE_TEST_WORKFLOW_TYPE,
  USER_TABLE_FAIL_TEST_WORKFLOW_TYPE,
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
      // play the agent's structured envelope: every step succeeds, so status "success" carries the step forward
      await handle.signal(agentResultSignal, {
        result: { status: "success", input: input.prompt, result: { note: input.prompt.slice(0, 16) } },
        outcome: "satisfied",
      });
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
        result: {
          status: "fail",
          input: input.prompt,
          result: { detail: "executor produced no tool call" },
        },
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
    expect((failure?.cause as Error)?.message).toMatch(/reported status "fail"/);

    // only the first step dispatched; the failure short-circuits the rest
    expect(dispatched).toHaveLength(1);
  });

  it("exports a stable workflow type string for the host to start it by", () => {
    expect(USER_TABLE_TEST_WORKFLOW_TYPE).toBe("userTableTestWorkflow");
  });

  // the negative twin: it must drive all three steps (create + the danaskully append + the foxmulder assert) and
  // fail on the verify, never returning the terminal message — proving a real verify-and-fail, not a short-circuit
  it("fails at verify: appends danaskully but asserts foxmulder", async () => {
    const dispatched: DispatchAgentTaskInput[] = [];
    // play the agent honestly: create/append succeed, but the verify of a row that was never written fails
    const dispatchAgentTask = jest.fn(async (input: DispatchAgentTaskInput) => {
      dispatched.push(input);
      const verifying = input.prompt.startsWith("Verify");
      const handle = env.client.workflow.getHandle(input.workId);
      await handle.signal(
        agentResultSignal,
        verifying
          ? {
              result: {
                status: "fail",
                input: input.prompt,
                result: { detail: "row userId=55, userName=foxmulder is missing" },
              },
              outcome: "failed",
            }
          : {
              result: { status: "success", input: input.prompt, result: {} },
              outcome: "satisfied",
            },
      );
    });

    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: "test",
      workflowsPath: require.resolve("../workflows/user-table-test.js"),
      activities: { dispatchAgentTask },
    });

    const failure = await worker
      .runUntil(
        env.client.workflow.execute(userTableFailTestWorkflow, {
          taskQueue: "test",
          workflowId: "WORK-FAIL-VERIFY",
          args: [{ workId: "WORK-FAIL-VERIFY", workspaceId: "WS-3", sessionId: "SESS-3" }],
        }),
      )
      .then(() => null)
      .catch((err: unknown) => err as Error & { cause?: Error });

    expect(failure).not.toBeNull();
    // step 4 (the third dispatched prompt) is the verify that fails — gated on the envelope's "fail" status
    expect((failure?.cause as Error)?.message).toMatch(/step 3 reported status "fail"/);
    expect(dispatched).toHaveLength(3);
    expect(dispatched[1].prompt).toContain("userId=88, userName=danaskully");
    expect(dispatched[2].prompt).toContain("userId=55 and userName=foxmulder");
  });

  it("exports a stable workflow type string for the failing twin", () => {
    expect(USER_TABLE_FAIL_TEST_WORKFLOW_TYPE).toBe("userTableFailTestWorkflow");
  });
});
