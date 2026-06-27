import { proxyActivities, defineSignal, setHandler, condition, log, workflowInfo, ApplicationFailure } from "@temporalio/workflow";
// type-only import: erased at runtime so the workflow sandbox stays pure (no bus / no node deps leak in)
import type { AgentActivities } from "./activities.js";

// the agent answers each dispatched step with this signal — TemporalClient.reportResult sends name "agentResult".
// result is the common response envelope { status, input, result }; outcome is the loop's own verdict (kept as a
// backstop). The step gates on envelope.status — the parseable ANSWER channel, distinct from "did the turn run".
export const agentResultSignal = defineSignal<[{ result: unknown; outcome?: string }]>("agentResult");

// operator intervention: merge variables onto the running workflow — TemporalClient.setVariables sends "inject"
export const injectSignal = defineSignal<[Record<string, unknown>]>("inject");

// the minimal start state every step-driven workflow seeds: the work-unit ids gathered at step 1. The OWNER is the
// host's principal (WorkStore keyed by userId), NOT an engine variable — the engine stays user-agnostic (M7-9),
// so no userId/identity rides into the workflow here. A workflow may extend this with its own arg type.
export interface StepRunnerArgs {
  workId: string;
  workspaceId: string;
}

// the agent's structured response envelope as it lands on the signal; result is the model-supplied structured payload
interface TurnResponseEnvelope {
  status?: unknown;
  input?: unknown;
  result?: unknown;
}

const { dispatchAgentTask } = proxyActivities<AgentActivities>({
  startToCloseTimeout: "5 minutes",
});

// shared step driver for step-based workflows: registers the agentResult/inject handlers and returns a runStep
// that dispatches one prompt, blocks on the matching answer, then GATES on its verdict — only a `success` envelope
// advances. Any other status (failed | capped | awaiting-input) means the step did not achieve its goal, so throw a
// non-retryable ApplicationFailure — this fails the workflow, which the host folds to `stopped` (with the agent's
// message), instead of the run sailing on to a false `completed`.
export function createStepRunner(args: StepRunnerArgs): (prompt: string) => Promise<unknown> {
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
