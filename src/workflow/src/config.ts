import { resolve } from "node:path";

// the one job type the sample BPMN service task carries; workers register against it
export const AGENT_EXECUTE_TASK_TYPE = "agent-execute";

export interface WorkflowConfig {
  bpmnDir: string;
  taskType: string;
  workerName: string;
  reconnectBaseMs: number;
  reconnectMaxMs: number;
}

// connection details (ZEEBE_*/CAMUNDA_* env) are read by the SDK itself; we only own engine-side knobs here
// baseDir lets ESM callers anchor the bpmn dir to the package (via import.meta.url) without this module touching it
export function loadConfig(env: NodeJS.ProcessEnv = process.env, baseDir: string = process.cwd()): WorkflowConfig {
  return {
    bpmnDir: env.WORKFLOW_BPMN_DIR ?? resolve(baseDir, "bpmn"),
    taskType: env.WORKFLOW_TASK_TYPE ?? AGENT_EXECUTE_TASK_TYPE,
    workerName: env.WORKFLOW_WORKER_NAME ?? "agent-execute-worker",
    reconnectBaseMs: Number(env.WORKFLOW_RECONNECT_BASE_MS ?? 1000),
    reconnectMaxMs: Number(env.WORKFLOW_RECONNECT_MAX_MS ?? 30000),
  };
}
