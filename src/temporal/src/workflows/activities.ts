import type { Eventing } from "@agent-local/common";

// one agent turn the workflow asks for: a prompt to run in its OWN per-step session. runKey (Temporal runId) +
// stepKey (the step ordinal) identify the step so the host mints/binds exactly one session per step — the workflow
// no longer carries a shared sessionId. The host resolves these to a fresh session at dispatch time.
export interface DispatchAgentTaskInput {
  workId: string;
  prompt: string;
  runKey: string;
  stepKey: string;
}

// the worker binds the host bus into the activity so the workflow stays pure; dispatch publishes the SAME
// workflow.job the agent consumes, so the agent never learns which engine drove the turn. temporalId carries
// our workId so the agent's agent.result round-trips back to THIS workflow (the temporal mount routes
// agent.result -> reportResult by temporalId == workId). runKey/stepKey let the host bind a per-step session.
export function createAgentActivities(bus: Eventing) {
  return {
    async dispatchAgentTask(input: DispatchAgentTaskInput): Promise<void> {
      bus.publish("workflow.job", {
        temporalId: input.workId,
        jobKey: input.workId,
        jobType: "agent-execute",
        variables: { prompt: input.prompt, temporalId: input.workId, runKey: input.runKey, stepKey: input.stepKey },
      });
    },
  };
}

export type AgentActivities = ReturnType<typeof createAgentActivities>;
