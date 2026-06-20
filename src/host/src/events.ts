// shared event taxonomy for the bus seam: workflow publishes these, the agent-client/receiver speak them
// over HTTP. Invariant — Camunda always initiates; agents answer jobs and report back, never start a process

// ---------------------------------------------------------------------------
// Event names
// ---------------------------------------------------------------------------

export const WORKFLOW_START = "workflow.start" as const;
export const WORKFLOW_STARTED = "workflow.started" as const;
export const WORKFLOW_STOP = "workflow.stop" as const;
// engine -> host: the cancel commanded by WORKFLOW_STOP has settled (pair to STARTED for START). drives the
// host's post-stop finalize (cleanup -> `cancelled`); a missed one heals via reconcile-on-refresh.
export const WORKFLOW_STOPPED = "workflow.stopped" as const;
export const WORKFLOW_INJECT = "workflow.inject" as const;
export const WORKFLOW_RETRY = "workflow.retry" as const;
// operator "continue": re-execute a stuck work's failed step via engine Reset (bus-pure, like stop/inject)
export const WORKFLOW_RESET = "workflow.reset" as const;
export const WORKFLOW_JOB = "workflow.job" as const;
export const WORKFLOW_COMPLETED = "workflow.completed" as const;
export const WORKFLOW_FAILED = "workflow.failed" as const;
// reconcile round-trip: the host asks the engine for an instance's live state (describe), the engine answers.
// bus-pure like every other engine interaction — the host never holds the engine client (see host mount seam).
export const WORKFLOW_DESCRIBE = "workflow.describe" as const;
export const WORKFLOW_STATUS = "workflow.status" as const;
export const AGENT_RESULT = "agent.result" as const;

export type EventName =
  | typeof WORKFLOW_START
  | typeof WORKFLOW_STARTED
  | typeof WORKFLOW_STOP
  | typeof WORKFLOW_STOPPED
  | typeof WORKFLOW_INJECT
  | typeof WORKFLOW_RETRY
  | typeof WORKFLOW_RESET
  | typeof WORKFLOW_JOB
  | typeof WORKFLOW_COMPLETED
  | typeof WORKFLOW_FAILED
  | typeof WORKFLOW_DESCRIBE
  | typeof WORKFLOW_STATUS
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

// the engine's acknowledgement: the process is live, here is its temporalId (the engine instance id) for the work unit
export interface WorkflowStartedPayload {
  workId: string;
  temporalId: string;
}

// the host commands a running process be cancelled (user stopped the work); the engine cancels the instance
// by its temporalId. bus-pure like WORKFLOW_START — the host never reaches into the engine directly.
export interface WorkflowStopPayload {
  workId: string;
  temporalId: string;
}

// engine -> host: the cancel has settled on the engine. keyed by temporalId (== workId) like the other terminal
// events; the host runs its post-stop cleanup and settles the work to `cancelled`.
export interface WorkflowStoppedPayload {
  temporalId: string;
}

// operator intervention: inject variables onto a running instance. scopeKey defaults to the instance root
// (temporalId); local=false merges so child scopes see them. bus-pure — the host authorizes, the engine merges.
export interface WorkflowInjectPayload {
  temporalId: string;
  variables: Record<string, unknown>;
  scopeKey?: string;
  local?: boolean;
}

// operator intervention: retry a failed step by its jobKey (bump retries; resolve its incident if one exists).
// inert until the worker actually fails jobs — today jobs are forwarded/held, so no incident is ever raised.
export interface WorkflowRetryPayload {
  jobKey: string;
  incidentKey?: string;
  retries?: number;
}

// host -> engine: re-execute this stuck work's failed step. keyed by workId (== the engine WorkflowId), so the
// engine resets that execution to its last workflow-task boundary; the engine refuses a reset while it is running.
export interface WorkflowResetPayload {
  workId: string;
}

export interface WorkflowJobPayload {
  temporalId: string;
  jobKey: string;
  jobType: string;
  variables: Record<string, unknown>;
}

export interface WorkflowCompletedPayload {
  temporalId: string;
  // the workflow's terminal return value (e.g. "user table created"); surfaced as the job's statusDescription
  result?: unknown;
}

export interface WorkflowFailedPayload {
  temporalId: string;
  jobKey?: string;
  error: string;
}

// host -> engine: reconcile this work's status against the engine's authoritative visibility (a poll-time read)
export interface WorkflowDescribePayload {
  workId: string;
}

// engine -> host: the answer, keyed by the host workId it was asked about (describe -> status round-trip).
// `missing` true when the engine has no such workflow (orphaned -> host marks stuck); otherwise `status` is
// the engine's current execution status string (running | completed | failed | …)
export interface WorkflowStatusPayload {
  workId: string;
  status?: string;
  missing?: boolean;
}

// jobKey is the host's correlation key for completing the camunda job. The agent's session is its own
// local knowledge (host gives jobKey -> agent creates/associates a session -> replies jobKey done), so it
// is deliberately NOT part of this payload.
export interface AgentResultPayload {
  temporalId: string;
  jobKey: string;
  result: unknown;
}

// maps each event name to its payload so publishers/subscribers stay in lockstep across workspaces
export interface EventPayloads {
  [WORKFLOW_START]: WorkflowStartPayload;
  [WORKFLOW_STARTED]: WorkflowStartedPayload;
  [WORKFLOW_STOP]: WorkflowStopPayload;
  [WORKFLOW_STOPPED]: WorkflowStoppedPayload;
  [WORKFLOW_INJECT]: WorkflowInjectPayload;
  [WORKFLOW_RETRY]: WorkflowRetryPayload;
  [WORKFLOW_RESET]: WorkflowResetPayload;
  [WORKFLOW_JOB]: WorkflowJobPayload;
  [WORKFLOW_COMPLETED]: WorkflowCompletedPayload;
  [WORKFLOW_FAILED]: WorkflowFailedPayload;
  [WORKFLOW_DESCRIBE]: WorkflowDescribePayload;
  [WORKFLOW_STATUS]: WorkflowStatusPayload;
  [AGENT_RESULT]: AgentResultPayload;
}
