// shared event taxonomy for the bus seam: workflow publishes these, the agent-client/receiver speak them
// over HTTP. Invariant — Camunda always initiates; agents answer jobs and report back, never start a process

// ---------------------------------------------------------------------------
// Event names
// ---------------------------------------------------------------------------

export const WORKFLOW_START = "workflow.start" as const;
export const WORKFLOW_STARTED = "workflow.started" as const;
export const WORKFLOW_STOP = "workflow.stop" as const;
export const WORKFLOW_JOB = "workflow.job" as const;
export const WORKFLOW_COMPLETED = "workflow.completed" as const;
export const WORKFLOW_FAILED = "workflow.failed" as const;
export const AGENT_RESULT = "agent.result" as const;

export type EventName =
  | typeof WORKFLOW_START
  | typeof WORKFLOW_STARTED
  | typeof WORKFLOW_STOP
  | typeof WORKFLOW_JOB
  | typeof WORKFLOW_COMPLETED
  | typeof WORKFLOW_FAILED
  | typeof AGENT_RESULT;

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

// the host commands a process start (bus-pure, so it never reaches into the workflow engine); the work-unit
// ids ride along so the engine seeds them as process variables and every later job carries them back.
export interface WorkflowStartPayload {
  workId: string;
  workspaceId: string;
  sessionId: string;
  workflowId: string;
}

// the engine's acknowledgement: the process is live, here is its processInstanceKey for the work unit
export interface WorkflowStartedPayload {
  workId: string;
  camundaId: string;
}

// the host commands a running process be cancelled (user stopped the work); the engine cancels the instance
// by its camundaId. bus-pure like WORKFLOW_START — the host never reaches into the engine directly.
export interface WorkflowStopPayload {
  workId: string;
  camundaId: string;
}

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
  [WORKFLOW_START]: WorkflowStartPayload;
  [WORKFLOW_STARTED]: WorkflowStartedPayload;
  [WORKFLOW_STOP]: WorkflowStopPayload;
  [WORKFLOW_JOB]: WorkflowJobPayload;
  [WORKFLOW_COMPLETED]: WorkflowCompletedPayload;
  [WORKFLOW_FAILED]: WorkflowFailedPayload;
  [AGENT_RESULT]: AgentResultPayload;
}
