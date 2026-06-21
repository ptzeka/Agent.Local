// the work unit's session id, sent by the host on every call; selects which runtime/session serves the request.
// shared by user_context (session-as-capability auth) and the job receiver (which session the runtime binds to).
export const SESSION_HEADER = "x-session-id";
