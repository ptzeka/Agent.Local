// the default Workflow Type a turn runs under; code-first, so there is nothing to deploy (Zeebe's bpmnProcessId analog)
export const AGENT_EXECUTE_WORKFLOW_TYPE = "agentExecuteWorkflow";

export interface TemporalConfig {
  address: string;
  namespace: string;
  taskQueue: string;
  defaultWorkflowType: string;
  // allowlist of workflow types permitted to start; empty = unrestricted (mirrors WorkflowSettings.enabledProcessIds)
  enabledWorkflowTypes: string[];
  reconnectBaseMs: number;
  reconnectMaxMs: number;
}

// connection details come from env only (never inline) so Temporal Cloud is the same client, different endpoint/mTLS
export function loadConfig(env: NodeJS.ProcessEnv = process.env): TemporalConfig {
  return {
    address: env.TEMPORAL_ADDRESS ?? "localhost:7233",
    namespace: env.TEMPORAL_NAMESPACE ?? "default",
    taskQueue: env.TEMPORAL_TASK_QUEUE ?? "agent-execute",
    defaultWorkflowType: env.TEMPORAL_WORKFLOW_TYPE ?? AGENT_EXECUTE_WORKFLOW_TYPE,
    enabledWorkflowTypes: env.TEMPORAL_ENABLED_WORKFLOW_TYPES?.split(",").map((s) => s.trim()).filter(Boolean) ?? [],
    reconnectBaseMs: Number(env.TEMPORAL_RECONNECT_BASE_MS ?? 1000),
    reconnectMaxMs: Number(env.TEMPORAL_RECONNECT_MAX_MS ?? 30000),
  };
}
