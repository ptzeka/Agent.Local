import type { Eventing } from "@agent-local/common";

// one agent turn the workflow asks for: a prompt to run under the work unit's session
export interface DispatchAgentTaskInput {
  workId: string;
  sessionId: string;
  prompt: string;
}

// the worker binds the host bus into the activity so the workflow stays pure; dispatch publishes the SAME
// workflow.job the agent consumes, so the agent never learns which engine drove the turn. temporalId carries
// our workId so the agent's agent.result round-trips back to THIS workflow (the temporal mount routes
// agent.result -> reportResult by temporalId == workId).
export function createAgentActivities(bus: Eventing) {
  return {
    async dispatchAgentTask(input: DispatchAgentTaskInput): Promise<void> {
      bus.publish("workflow.job", {
        temporalId: input.workId,
        jobKey: input.workId,
        jobType: "agent-execute",
        variables: { prompt: input.prompt, sessionId: input.sessionId, temporalId: input.workId },
      });
    },
  };
}

export type AgentActivities = ReturnType<typeof createAgentActivities>;
