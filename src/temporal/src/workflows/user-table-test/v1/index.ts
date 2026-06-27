import { createStepRunner, type StepRunnerArgs } from "../../_shared/step-runner.js";
import type { WorkflowTemplate } from "../../_shared/template.js";

// the workflow type string == this function's name; the host starts it via TemporalClient.startProcess(type, ...)
export const USER_TABLE_TEST_WORKFLOW_TYPE = "userTableTestWorkflow";

// the dropdown descriptor for this workflow: `name` is the Temporal Workflow Type started above, so the console
// offers exactly what the worker can run (the catalog in workflows/index.ts aggregates these)
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
export interface UserTableTestArgs extends StepRunnerArgs {}

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
