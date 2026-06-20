// the agent worker's own view of the bus seam. The bus carries untyped payloads, so the listener owns
// the shapes it consumes and emits — it does NOT import a shared contract (engines couple only through
// the bus, never through each other). The workflow engine always initiates: the worker reacts to workflow.*
// and reports back as agent.result / workflow.failed; it never starts a process.

// inbound: the workflow job this worker runs (published by the workflow mount)
export const WORKFLOW_JOB = "workflow.job";
// inbound: instance lifecycle, used to finalize the per-instance agent session
export const WORKFLOW_COMPLETED = "workflow.completed";
export const WORKFLOW_FAILED = "workflow.failed";
// outbound: the agent's answer, consumed by the workflow mount to complete the workflow job
export const AGENT_RESULT = "agent.result";

// the workflow job payload the worker reads off the bus; temporalId is the engine instance id the answer routes back to
export interface WorkflowJob {
  temporalId: string;
  jobKey: string;
  jobType: string;
  variables: Record<string, unknown>;
}

export interface WorkflowCompleted {
  temporalId: string;
}

export interface WorkflowFailed {
  temporalId: string;
  jobKey?: string;
  error: string;
}
