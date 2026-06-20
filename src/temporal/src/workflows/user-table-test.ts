import { proxyActivities, defineSignal, setHandler, condition } from "@temporalio/workflow";
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

// start args = the work-unit ids the host seeds at trigger; step 1 "gathers" them into the workflow state.
// the OWNER is the host's principal (JobRegistry keyed by userId), NOT an engine variable — the engine stays
// user-agnostic (M7-9), so no userId/identity rides into the workflow here.
export interface UserTableTestArgs {
  workId: string;
  workspaceId: string;
  sessionId: string;
}

// the agent answers each dispatched step with this signal — TemporalClient.reportResult sends name "agentResult"
export const agentResultSignal = defineSignal<[{ result: unknown }]>("agentResult");
// operator intervention: merge variables onto the running workflow — TemporalClient.setVariables sends "inject"
export const injectSignal = defineSignal<[Record<string, unknown>]>("inject");

const { dispatchAgentTask } = proxyActivities<AgentActivities>({
  startToCloseTimeout: "5 minutes",
});

// a code-first test workflow that drives the agent through a users-table scenario, proving the mount seam is
// engine-agnostic: initialize -> create sheet -> add record -> assert row -> done. The agent reports each step
// back via the agentResult signal and the WORKFLOW decides when it is done (returns the terminal message).
export async function userTableTestWorkflow(args: UserTableTestArgs): Promise<string> {
  // the workflow IS the session: state gathered at initialize and carried across steps with no external store
  const session: Record<string, unknown> = {};

  // each agentResult signal appends here; a step waits for its own answer to land before advancing
  const results: unknown[] = [];
  setHandler(agentResultSignal, (payload) => void results.push(payload.result));
  setHandler(injectSignal, (vars) => void Object.assign(session, vars));

  // dispatch one prompt, then block until the agent's next agentResult arrives (Temporal's done/next decision)
  const runStep = async (prompt: string): Promise<unknown> => {
    const awaited = results.length + 1;
    await dispatchAgentTask({ workId: args.workId, sessionId: args.sessionId, prompt });
    await condition(() => results.length >= awaited);
    return results[awaited - 1];
  };

  // step 1 — initialize: gather the start command's variables into the session (no agent turn)
  session.workId = args.workId;
  session.workspaceId = args.workspaceId;
  session.sessionId = args.sessionId;

  // step 2 — ask the agent to create the users sheet
  await runStep(`Create an Excel sheet named "users" with two columns: userId, userName.`);

  // step 3 — ask the agent to add a record (userId/userName are domain TEST DATA, not the principal owner)
  await runStep(`Append a row to the "users" sheet with userId=55, userName=foxmulder.`);

  // step 4 — ask the agent to assert the row is present
  await runStep(`Verify the "users" sheet has a row where userId=55 and userName=foxmulder; fail if it is missing.`);

  // step 5 — complete the work unit with the terminal message
  return "user table created";
}
