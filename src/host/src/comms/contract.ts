// the host<->agent wire seam: the events that actually cross HTTP between this host and the agent service.
// the host's full bus taxonomy lives in ../events.ts; this re-exports only the subset sender/receiver speak,
// so the transport contract is findable in one place beside sender.ts and receiver.ts.
export {
  WORKFLOW_JOB,
  AGENT_RESULT,
  WORKFLOW_FAILED,
  type WorkflowJobPayload,
  type AgentResultPayload,
  type WorkflowFailedPayload,
} from "../events.js";
export type { EventEnvelope } from "@agent-local/common";
