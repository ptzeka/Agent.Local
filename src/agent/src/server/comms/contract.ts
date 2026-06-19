// the agent worker's own view of the bus seam. The bus carries untyped payloads, so the listener owns
// the shapes it consumes and emits — it does NOT import a shared contract (engines couple only through
// the bus, never through each other). Camunda always initiates: the worker reacts to workflow.* and
// reports back as agent.result / workflow.failed; it never starts a process.

// inbound: the camunda job this worker runs (published by the workflow mount)
export const WORKFLOW_JOB = "workflow.job";
// inbound: instance lifecycle, used to finalize the per-instance agent session
export const WORKFLOW_COMPLETED = "workflow.completed";
export const WORKFLOW_FAILED = "workflow.failed";
// outbound: the agent's answer, consumed by the workflow mount to complete the camunda job
export const AGENT_RESULT = "agent.result";

// the camunda job payload the worker reads off the bus
export interface WorkflowJob {
  processInstanceKey: string;
  jobKey: string;
  jobType: string;
  variables: Record<string, unknown>;
}

export interface WorkflowCompleted {
  processInstanceKey: string;
}

export interface WorkflowFailed {
  processInstanceKey: string;
  jobKey?: string;
  error: string;
}
