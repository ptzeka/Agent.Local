import { Eventing } from "./index.js";

// ---------------------------------------------------------------------------
// Camunda workflow event contract
// ---------------------------------------------------------------------------

// CAMUNDA ALWAYS INITIATES: the workflow workspace publishes these onto the bus;
// the mesh only listens and correlates, it never calls a camunda client directly.
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

// the reserved return path back DOWN to camunda: a later agentic package publishes this
// to complete the job; the mesh records the seam but does not yet act on it
export interface AgentResultPayload {
  processInstanceKey: string;
  jobKey: string;
  sessionId: string;
  result: unknown;
}

export const WORKFLOW_JOB = "workflow.job";
export const WORKFLOW_COMPLETED = "workflow.completed";
export const WORKFLOW_FAILED = "workflow.failed";
// the correlated job the mesh emits for the agent worker to pick up (bus-only seam, no direct call)
export const AGENT_JOB = "agent.job";
export const AGENT_RESULT = "agent.result";

// ---------------------------------------------------------------------------
// Mesh wiring
// ---------------------------------------------------------------------------

// what the mesh hands the agent seam: the raw job plus the sessionId it correlated
export interface CorrelatedJob extends WorkflowJobPayload {
  sessionId: string;
}

export interface CamundaMeshDeps {
  // SEAM: by default the mesh re-publishes the correlated job as AGENT_JOB so the agent worker can pick
  // it up off the bus (bus-only, no direct coupling). Override only for deterministic tests.
  dispatchToAgent?: (job: CorrelatedJob) => void;
  // override only for deterministic tests; default derives a stable id from the job keys
  sessionIdFor?: (job: WorkflowJobPayload) => string;
}

// one sessionId per processInstance so every job of a workflow shares the agent session
function defaultSessionId(job: WorkflowJobPayload): string {
  return `pi:${job.processInstanceKey}`;
}

// subscribes a bus to the camunda workflow events and correlates jobKey/processInstanceKey -> sessionId
// pure to the bus (no express, no camunda client); returns an unsubscribe that also clears the correlation map
export function wireCamundaMesh(bus: Eventing, deps: CamundaMeshDeps = {}): () => void {
  // default seam: emit the correlated job onto the bus for the agent worker (subscribes to AGENT_JOB)
  const dispatchToAgent = deps.dispatchToAgent ?? ((job: CorrelatedJob) => bus.publish(AGENT_JOB, { ...job }));
  const sessionIdFor = deps.sessionIdFor ?? defaultSessionId;

  // jobKey -> sessionId and processInstanceKey -> sessionId, so either key can resolve a session
  const byJobKey = new Map<string, string>();
  const byProcessInstance = new Map<string, string>();

  const unsubscribe = bus.subscribe((event) => {
    switch (event.type) {
      case WORKFLOW_JOB: {
        const job = event.payload as unknown as WorkflowJobPayload;
        // reuse the process-instance session if a prior job of this workflow already opened one
        const sessionId = byProcessInstance.get(job.processInstanceKey) ?? sessionIdFor(job);
        byProcessInstance.set(job.processInstanceKey, sessionId);
        byJobKey.set(job.jobKey, sessionId);
        dispatchToAgent({ ...job, sessionId });
        return;
      }
      case WORKFLOW_COMPLETED: {
        const done = event.payload as unknown as WorkflowCompletedPayload;
        // drop the workflow's correlations once it finishes so the map can't grow unbounded
        const sessionId = byProcessInstance.get(done.processInstanceKey);
        byProcessInstance.delete(done.processInstanceKey);
        if (sessionId) for (const [k, v] of byJobKey) if (v === sessionId) byJobKey.delete(k);
        return;
      }
      case WORKFLOW_FAILED: {
        const failed = event.payload as unknown as WorkflowFailedPayload;
        // a failed job retires only its own correlation; the instance may still have live jobs
        if (failed.jobKey) byJobKey.delete(failed.jobKey);
        else byProcessInstance.delete(failed.processInstanceKey);
        return;
      }
    }
  });

  return () => {
    unsubscribe();
    byJobKey.clear();
    byProcessInstance.clear();
  };
}
