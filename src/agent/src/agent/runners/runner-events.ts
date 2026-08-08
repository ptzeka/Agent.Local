// centralised so a coordinator and its sub-agents share one event vocabulary
export const OrchestratorEventTypes = {
  START: "orchestrator-start",
  ITERATION: "orchestrator-iteration",
  // opens a streamed assistant message; carries { emitter } so the renderer labels it without a hardcoded branch
  CHAT_START: "chat-start",
  // one text delta off the provider stream; MESSAGE stays the terminal/stop event
  MESSAGE_DELTA: "message-delta",
  MESSAGE: "orchestrator-message",
  TOOL_CALL: "tool-call",
  TOOL_RESULT: "tool-result",
  DISPATCH_START: "dispatch-start",
  DISPATCH_FEEDBACK: "dispatch-feedback",
  // one sub-agent event republished on the parent bus; `kind` carries the child's own type
  AGENT_EVENT: "agent-event",
  FINAL_MESSAGE: "final-message",
  SUMMARIZATION_START: "summarization-start",
  SUMMARIZATION: "summarization",
  EVALUATION_START: "evaluation-start",
  EVALUATION_VERDICT: "evaluation-verdict",
  SYSTEM_FAILURE: "system-failure",
  // a token ceiling stopped the turn; distinct from WARNING so a host can act on cost, not parse prose
  BUDGET_EXCEEDED: "budget-exceeded",
  INJECTED_INPUT: "injected-input",
  RECALL_START: "recall-start",
  RECALL_FINALIZE: "recall-finalize",
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

export type RunnerEvent = OrchestratorEvent | ExecutorEvent;

export type RunnerListener = (event: RunnerEvent) => void;
