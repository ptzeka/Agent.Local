// the agent's host-agnostic execution contract. The agent never learns which engine drove a run: the wire
// carries a neutral request/result, and `runId` is opaque (echoed, never interpreted) so the host alone routes
// the answer back to its own work unit. No `eventType` envelope, no `temporalId`/`jobKey` — that vocabulary is
// host-private. The HTTP payloads are the wire contract; the bus events below are the internal one (they differ:
// the receiver enriches the request with who/when before the runner sees it).

// internal bus: the receiver translates an inbound HTTP request into this for the runner to execute
export const EXECUTION_REQUESTED = "execution.requested";
// internal bus: the runner publishes this finished turn for the sender to POST back to the host
export const EXECUTION_RESULT = "execution.result";
// internal bus: the host closed a session (Stop/pause) — the runner aborts that session's in-flight one-shot run
export const EXECUTION_CANCEL = "execution.cancel";
// internal bus: the user pressed Stop in the live chat — the runner cancels that session's in-flight TURN but
// leaves the runtime up (distinct from CANCEL, which tears a one-shot run down), so the chat stays usable
export const EXECUTION_INTERRUPT = "execution.interrupt";

// inbound wire payload (POST /receive). sessionId rides the x-session-id header, not the body, so it doubles
// as the session-binding the runtime resumes against.
export interface ExecutionRequest {
  runId: string;
  input: string;
}

// the cancel event's payload: which session's in-flight one-shot run the runner must abort
export interface ExecutionCancel {
  sessionId: string;
}

// the interrupt event's payload: which live session's in-flight turn the runner must cancel (runtime kept alive)
export interface ExecutionInterrupt {
  sessionId: string;
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

// the common response envelope every finished turn carries: status is the parseable verdict the caller gates on,
// input echoes the dispatched prompt, result is the agent's structured payload. Produced by the report_result tool
// on a dispatched run; the dispatch boundary synthesizes a fallback envelope for turns that didn't report one.
export interface TurnResponse {
  status: "success" | "fail";
  input: string;
  result: unknown;
}

// outbound wire payload (POST host /receive) and the EXECUTION_RESULT bus event — the finished turn. result is the
// structured envelope; outcome is the loop's own verdict, kept so the host can gate without re-deriving from status.
export interface ExecutionResult {
  sessionId: string;
  runId: string;
  source: string;
  createdAt: string;
  result: TurnResponse;
  outcome: string;
}
