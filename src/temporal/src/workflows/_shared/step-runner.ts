import { proxyActivities, defineSignal, setHandler, condition, log, workflowInfo, ApplicationFailure } from "@temporalio/workflow";
// type-only import: erased at runtime so the workflow sandbox stays pure (no bus / no node deps leak in)
import type { AgentActivities } from "./activities.js";

// the step gates on envelope.status; outcome is the loop's own verdict, kept as a backstop
export const agentResultSignal = defineSignal<[{ result: unknown; outcome?: string }]>("agentResult");

export const injectSignal = defineSignal<[Record<string, unknown>]>("inject");

// no userId/identity rides into the workflow — the engine stays user-agnostic (M7-9)
export interface StepRunnerArgs {
  workId: string;
  workspaceId: string;
}

interface TurnResponseEnvelope {
  status?: unknown;
  input?: unknown;
  result?: unknown;
}

const { dispatchAgentTask } = proxyActivities<AgentActivities>({
  startToCloseTimeout: "5 minutes",
});

// returns a runStep that dispatches one prompt, blocks on the matching answer, then gates on its verdict: only a
// `success` envelope advances. Any other status throws non-retryable, failing the workflow (host folds to `stopped`).
export function createStepRunner(args: StepRunnerArgs): (prompt: string) => Promise<unknown> {
  // the workflow IS the session: state carried across steps with no external store
  const session: Record<string, unknown> = {
    workId: args.workId,
    workspaceId: args.workspaceId,
  };
  // a reset spawns a new runId, so the host discards the old run's per-step sessions; replay-stable
  const runKey = workflowInfo().runId;
  const results: { result: unknown; outcome?: string }[] = [];
  setHandler(agentResultSignal, (payload) => void results.push(payload));
  setHandler(injectSignal, (vars) => void Object.assign(session, vars));

  return async (prompt: string): Promise<unknown> => {
    const awaited = results.length + 1;
    // stepKey = the dispatch ordinal (deterministic across replay); with runKey it uniquely binds this step's session
    await dispatchAgentTask({ workId: args.workId, prompt, runKey, stepKey: String(awaited) });
    await condition(() => results.length >= awaited);
    const answer = results[awaited - 1];
    // fail closed: a "fail" verdict OR a missing/malformed envelope throws, since a verify gate must not pass on doubt
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
