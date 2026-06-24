import { proxyActivities, defineSignal, setHandler, condition, log, workflowInfo, ApplicationFailure } from "@temporalio/workflow";
// type-only imports: erased at runtime so the workflow sandbox stays pure (no bus / no node deps leak in)
import type { AgentActivities } from "./activities.js";
import type { WorkflowTemplate } from "./index.js";

// the workflow type string == this function's name; the host starts it via TemporalClient.startProcess(type, ...)
export const USER_TABLE_TEST_WORKFLOW_TYPE = "userTableTestWorkflow";

// the dropdown descriptor for this workflow: `name` is the Temporal Workflow Type started above, so the console
// offers exactly what the worker can run (the catalog in ./index.ts aggregates these)
export const userTableTestTemplate: WorkflowTemplate = {
  name: USER_TABLE_TEST_WORKFLOW_TYPE,
  label: "User Table Test",
};

// sibling workflow whose verify step is DESIGNED to fail: it appends danaskully but asserts foxmulder, so the
// agent's verify turn must report a non-satisfied verdict and fail the run — exercising the real verify-and-fail
// path (not a mocked verdict). Same Workflow Type string == this function's name.
export const USER_TABLE_FAIL_TEST_WORKFLOW_TYPE = "userTableFailTestWorkflow";

export const userTableFailTestTemplate: WorkflowTemplate = {
  name: USER_TABLE_FAIL_TEST_WORKFLOW_TYPE,
  label: "User Table Test (Verify Fails)",
};

// start args = the work-unit ids the host seeds at trigger; step 1 "gathers" them into the workflow state.
// the OWNER is the host's principal (WorkStore keyed by userId), NOT an engine variable — the engine stays
// user-agnostic (M7-9), so no userId/identity rides into the workflow here.
export interface UserTableTestArgs {
  workId: string;
  workspaceId: string;
}

// the agent answers each dispatched step with this signal — TemporalClient.reportResult sends name "agentResult".
// result is the common response envelope { status, input, result }; outcome is the loop's own verdict (kept as a
// backstop). The step gates on envelope.status — the parseable ANSWER channel, distinct from "did the turn run".
export const agentResultSignal = defineSignal<[{ result: unknown; outcome?: string }]>("agentResult");

// the agent's structured response envelope as it lands on the signal; result is the model-supplied structured payload
interface TurnResponseEnvelope {
  status?: unknown;
  input?: unknown;
  result?: unknown;
}
// operator intervention: merge variables onto the running workflow — TemporalClient.setVariables sends "inject"
export const injectSignal = defineSignal<[Record<string, unknown>]>("inject");

const { dispatchAgentTask } = proxyActivities<AgentActivities>({
  startToCloseTimeout: "5 minutes",
});

// shared step driver for the user-table workflows: registers the agentResult/inject handlers and returns a
// runStep that dispatches one prompt, blocks on the matching answer, then GATES on its verdict — only a
// `satisfied` turn advances. Any other outcome (failed | capped | awaiting-input) means the step did not achieve
// its goal, so throw a non-retryable ApplicationFailure — this fails the workflow, which the host folds to
// `stopped` (with the agent's message), instead of the run sailing on to a false `completed`.
function createStepRunner(args: UserTableTestArgs): (prompt: string) => Promise<unknown> {
  // the workflow IS the session: state gathered at initialize and carried across steps with no external store
  const session: Record<string, unknown> = {
    workId: args.workId,
    workspaceId: args.workspaceId,
  };
  // runId identifies this run (the generation); a reset spawns a new one, so the host discards the old run's
  // per-step sessions. replay-safe: workflowInfo() returns the same runId on every replay of this run.
  const runKey = workflowInfo().runId;
  // each agentResult signal appends here; a step waits for its own answer to land before advancing
  const results: { result: unknown; outcome?: string }[] = [];
  setHandler(agentResultSignal, (payload) => void results.push(payload));
  setHandler(injectSignal, (vars) => void Object.assign(session, vars));

  return async (prompt: string): Promise<unknown> => {
    const awaited = results.length + 1;
    // log.* is the replay-safe sink (suppressed on replay), so the step trace stays deterministic
    log.info("runStep dispatch", { workId: args.workId, step: awaited, prompt });
    // stepKey = the dispatch ordinal (deterministic across replay); with runKey it uniquely binds this step's session
    await dispatchAgentTask({ workId: args.workId, prompt, runKey, stepKey: String(awaited) });
    await condition(() => results.length >= awaited);
    const answer = results[awaited - 1];
    // gate on the structured envelope's status — the parseable ANSWER, so a true-but-negative verify (e.g. row
    // missing) fails the step even though the turn ran honestly. FAIL CLOSED: a "fail" verdict OR a missing/
    // malformed envelope throws — the opposite bias to the evaluator's fail-open, since a verify gate must not
    // pass on doubt. The agent always sends an envelope (the dispatch boundary synthesizes one as a fallback).
    const envelope = answer.result as TurnResponseEnvelope | undefined;
    if (envelope?.status !== "success") {
      throw ApplicationFailure.nonRetryable(
        `step ${awaited} reported status "${String(envelope?.status)}" ` +
          `(outcome: ${answer.outcome ?? "n/a"}): ${JSON.stringify(envelope?.result ?? answer.result)}`,
        "AgentStepFailed",
      );
    }
    return envelope.result;
  };
}

// a code-first test workflow that drives the agent through a users-table scenario, proving the mount seam is
// engine-agnostic: initialize -> create sheet -> add record -> assert row -> done. The agent reports each step
// back via the agentResult signal and the WORKFLOW decides when it is done (returns the terminal message).
export async function userTableTestWorkflow(args: UserTableTestArgs): Promise<string> {
  // step 1 — initialize: gather the start command's variables into the session (no agent turn)
  const runStep = createStepRunner(args);

  // step 2 — ask the agent to create the users sheet
  await runStep(`Create an Excel sheet named "users" with three columns: index (row index), userId, userName.`);

  // step 3 — ask the agent to add a record (userId/userName are domain TEST DATA, not the principal owner)
  await runStep(`Append a row to the "users" sheet with index, userId=55, userName=foxmulder.`);

  // step 4 — ask the agent to assert the row is present
  await runStep(`Verify the "users" sheet has a row where userId=55 and userName=foxmulder; fail if it is missing.`);

  // step 5 — complete the work unit with the terminal message
  return "user table created";
}

// the negative twin: appends danaskully (88) but asserts foxmulder (55), so the verify step's agent turn must
// find the row missing and report a non-satisfied verdict — runStep then fails the run. Proves the agent really
// checks the sheet rather than rubber-stamping the last step, and that a failed verify never reaches `completed`.
export async function userTableFailTestWorkflow(args: UserTableTestArgs): Promise<string> {
  // step 1 — initialize (no agent turn)
  const runStep = createStepRunner(args);

  // step 2 — create the users sheet
  await runStep(`Create an Excel sheet named "users" with three columns: (row index), userId, userName.`);

  // step 3 — append a DIFFERENT row than the one the next step asserts, so the verify is bound to fail
  await runStep(`Append a row to the "users" sheet with index, userId=88, userName=danaskully.`);

  // step 4 — assert a row that was never written; the agent must report failure here
  await runStep(`Verify the "users" sheet has a row where userId=55 and userName=foxmulder; fail if it is missing.`);

  // step 5 — unreachable when the agent verifies honestly; present only so a buggy rubber-stamp would surface here
  return "user table verified";
}
