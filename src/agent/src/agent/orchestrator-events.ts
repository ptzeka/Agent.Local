/**
 * Orchestrator event types and listener callback.
 * Extracted to a shared location to avoid circular imports.
 */

export interface OrchestratorEvent {
  type:
    | "orchestrator-start"
    | "orchestrator-iteration"
    | "orchestrator-message"
    | "tool-call"
    | "tool-result"
    | "dispatch-start"
    | "dispatch-feedback"
    | "executor-event"
    | "final-message"
    | "summarization"
    | "evaluation-start"
    | "evaluation-verdict"
    | "injected-input"
    | "subsession-start"
    | "subsession-status"
    | "subsession-finalize"
    | "warning";
  data: Record<string, unknown>;
}

export type OrchestratorListener = (event: OrchestratorEvent) => void;
