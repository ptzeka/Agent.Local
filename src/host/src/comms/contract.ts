// the host<->agent wire seam. The host keeps its engine vocabulary on its OWN bus (workflow.* / agent.result);
// the sender/receiver translate to and from the NEUTRAL execution contract the agent speaks, mapping runId <->
// the host's workId/temporalId at this boundary so the engine ids never cross the wire.
export { WORKFLOW_JOB, AGENT_RESULT, WORKFLOW_FAILED, type WorkflowJobPayload } from "../events.js";

// neutral wire contract — a mirror of the agent's (no shared module; the two couple by the wire shape, like the
// rest of the bus seam). runId is the host's opaque correlation; sessionId rides the x-session-id header outbound.
export interface ExecutionRequest {
  runId: string;
  input: string;
}

// the common response envelope mirrored from the agent's wire (couple by shape, no shared module). status is the
// parseable verdict the workflow gates on; input echoes the dispatched prompt; result is the agent's structured payload.
export interface TurnResponse {
  status: "success" | "fail";
  input: string;
  result: unknown;
}

export interface ExecutionResult {
  sessionId: string;
  runId: string;
  source: string;
  createdAt: string;
  result: TurnResponse;
  outcome: string;
}
