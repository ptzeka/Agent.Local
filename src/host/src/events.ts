// shared event taxonomy for the bus seam: workflow publishes these, the agent-client/receiver speak them
// over HTTP. Invariant — Camunda always initiates; agents answer jobs and report back, never start a process

// ---------------------------------------------------------------------------
// Event names
// ---------------------------------------------------------------------------

export const WORKFLOW_JOB = "workflow.job" as const;
export const WORKFLOW_COMPLETED = "workflow.completed" as const;
export const WORKFLOW_FAILED = "workflow.failed" as const;
export const AGENT_RESULT = "agent.result" as const;

export type EventName =
  | typeof WORKFLOW_JOB
  | typeof WORKFLOW_COMPLETED
  | typeof WORKFLOW_FAILED
  | typeof AGENT_RESULT;

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

export interface WorkflowJobPayload {
  processInstanceKey: string;
  jobKey: string;
  jobType: string;
  variables: Record<string, unknown>;
}

export interface WorkflowCompletedPayload {
  processInstanceKey: string;
}

export interface WorkflowFailedPayload {
  processInstanceKey: string;
  jobKey?: string;
  error: string;
}

// jobKey is the host's correlation key for completing the camunda job. The agent's session is its own
// local knowledge (host gives jobKey -> agent creates/associates a session -> replies jobKey done), so it
// is deliberately NOT part of this payload.
export interface AgentResultPayload {
  processInstanceKey: string;
  jobKey: string;
  result: unknown;
}

// maps each event name to its payload so publishers/subscribers stay in lockstep across workspaces
export interface EventPayloads {
  [WORKFLOW_JOB]: WorkflowJobPayload;
  [WORKFLOW_COMPLETED]: WorkflowCompletedPayload;
  [WORKFLOW_FAILED]: WorkflowFailedPayload;
  [AGENT_RESULT]: AgentResultPayload;
}
