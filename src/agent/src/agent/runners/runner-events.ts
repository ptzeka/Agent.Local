/**
 * Event types and listeners for orchestrator and executor runners.
 * Centralizes event type definitions so both roles share a consistent system.
 */

export const OrchestratorEventTypes = {
  START: "orchestrator-start",
  ITERATION: "orchestrator-iteration",
  MESSAGE: "orchestrator-message",
  TOOL_CALL: "tool-call",
  TOOL_RESULT: "tool-result",
  DISPATCH_START: "dispatch-start",
  DISPATCH_FEEDBACK: "dispatch-feedback",
  EXECUTOR_EVENT: "executor-event",
  FINAL_MESSAGE: "final-message",
  SUMMARIZATION_START: "summarization-start",
  SUMMARIZATION: "summarization",
  EVALUATION_START: "evaluation-start",
  EVALUATION_VERDICT: "evaluation-verdict",
  SYSTEM_FAILURE: "system-failure",
  INJECTED_INPUT: "injected-input",
  SUBSESSION_START: "subsession-start",
  SUBSESSION_STATUS: "subsession-status",
  SUBSESSION_FINALIZE: "subsession-finalize",
  WARNING: "warning",
} as const;

export const ExecutorEventTypes = {
  START: "executor-start",
  ACK: "executor-ack",
  TOOL_CALL: "executor-tool-call",
  TOOL_RESULT: "executor-tool-result",
  VALIDATE: "executor-validate",
  REPORT: "executor-report",
  DETERMINISTIC_VERDICT: "executor-deterministic-verdict",
  WARNING: "executor-warning",
} as const;

export type OrchestratorEventType = typeof OrchestratorEventTypes[keyof typeof OrchestratorEventTypes];
export type ExecutorEventType = typeof ExecutorEventTypes[keyof typeof ExecutorEventTypes];

export interface OrchestratorEvent {
  type: OrchestratorEventType;
  data: Record<string, unknown>;
}

export interface ExecutorEvent {
  type: ExecutorEventType;
  data: Record<string, unknown>;
}

export type OrchestratorListener = (event: OrchestratorEvent) => void;
export type ExecutorListener = (event: ExecutorEvent) => void;

/** Union type for events from either role. */
export type RunnerEvent = OrchestratorEvent | ExecutorEvent;

/** Generic listener that can handle either role's events. */
export type RunnerListener = (event: RunnerEvent) => void;
