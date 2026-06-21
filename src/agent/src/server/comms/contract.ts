// the agent's host-agnostic execution contract. The agent never learns which engine drove a run: the wire
// carries a neutral request/result, and `runId` is opaque (echoed, never interpreted) so the host alone routes
// the answer back to its own work unit. No `eventType` envelope, no `temporalId`/`jobKey` — that vocabulary is
// host-private. The HTTP payloads are the wire contract; the bus events below are the internal one (they differ:
// the receiver enriches the request with who/when before the runner sees it).

// internal bus: the receiver translates an inbound HTTP request into this for the runner to execute
export const EXECUTION_REQUESTED = "execution.requested";
// internal bus: the runner publishes this finished turn for the sender to POST back to the host
export const EXECUTION_RESULT = "execution.result";

// inbound wire payload (POST /receive). sessionId rides the x-session-id header, not the body, so it doubles
// as the session-binding the runtime resumes against.
export interface ExecutionRequest {
  runId: string;
  input: string;
}

// the runner's bus event: the request plus the provenance the receiver stamped (source from the JWT, createdAt
// from the clock) so the runner carries them straight onto the result without re-reading the request context.
export interface ExecutionRequested {
  sessionId: string;
  runId: string;
  source: string;
  createdAt: string;
  input: string;
}

// outbound wire payload (POST host /receive) and the EXECUTION_RESULT bus event — the finished turn. outcome is
// the turn's own verdict so the host fails a step on a non-satisfied turn without sniffing the text.
export interface ExecutionResult {
  sessionId: string;
  runId: string;
  source: string;
  createdAt: string;
  result: string;
  outcome: string;
}
