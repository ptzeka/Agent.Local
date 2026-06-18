// public surface of the agent engine for out-of-process hosts (the server package wraps this over HTTP).
// keeps the cli + engine internals private while exposing exactly what a host needs to build a runtime.
export { buildRuntime } from "./agent/runtime/build-runtime.js";
export type { AgentRuntime } from "./agent/runtime/agent-runtime.js";
export type { AgentRuntimeDeps } from "./agent/runtime/types.js";
