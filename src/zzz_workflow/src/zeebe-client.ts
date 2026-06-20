import { readdirSync } from "node:fs";
import { join } from "node:path";
import { Camunda8 } from "@camunda8/sdk";
import type { Eventing } from "@agent-local/common";
import type { ILogger } from "@agent-local/common/ilogger";
import type { WorkflowConfig } from "./config.js";

// the SDK's gRPC client is typed loosely across versions; pin the few methods we call behind a local shape
export interface ZeebeGrpc {
  deployResource(req: { processFilename: string }): Promise<unknown>;
  createProcessInstance(req: { bpmnProcessId: string; variables: Record<string, unknown> }): Promise<{ processInstanceKey: string }>;
  createWorker(cfg: {
    taskType: string;
    taskHandler: (job: ZeebeJob) => Promise<unknown>;
    name?: string;
  }): { close(): Promise<void> };
  completeJob(req: { jobKey: string; variables: Record<string, unknown> }): Promise<unknown>;
  cancelProcessInstance(req: { processInstanceKey: string }): Promise<unknown>;
  setVariables(req: { elementInstanceKey: string; variables: Record<string, unknown>; local: boolean }): Promise<unknown>;
  updateJobRetries(req: { jobKey: string; retries: number }): Promise<unknown>;
  resolveIncident(req: { incidentKey: string }): Promise<unknown>;
  topology(): Promise<unknown>;
  close(): Promise<void>;
}

interface ZeebeJob {
  key: string;
  type: string;
  processInstanceKey: string;
  variables: Record<string, unknown>;
  complete(variables?: Record<string, unknown>): Promise<unknown>;
  fail(arg: { errorMessage: string; retries?: number }): Promise<unknown>;
  forward(): unknown;
}

// a start was refused by the enablement allowlist, not by the broker; lets callers map it to 403 not 503
export class WorkflowDisabledError extends Error {
  constructor(public readonly bpmnProcessId: string) {
    super(`workflow '${bpmnProcessId}' is not enabled`);
    this.name = "WorkflowDisabledError";
  }
}

// what we know about an instance we started; the engine owns true state, this is a thin local reflection
export interface InstanceRecord {
  processInstanceKey: string;
  bpmnProcessId: string;
  status: "active" | "completed" | "failed";
  startedAt: number;
}

// owns the single Zeebe connection: deploys BPMN, runs the job worker, and publishes job lifecycle onto the bus
// CAMUNDA ALWAYS INITIATES — this worker only reacts to activated jobs and reports back; it never starts a process on its own
export class ZeebeClient {
  private readonly grpc: ZeebeGrpc;
  private worker?: { close(): Promise<void> };
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private started = false;
  // local reflection of instances we started, keyed by processInstanceKey, for the GET state endpoint
  private readonly instances = new Map<string, InstanceRecord>();

  // grpc is injectable so tests run without a broker; defaults to the SDK's gRPC client
  constructor(
    private readonly cfg: WorkflowConfig,
    private readonly bus: Eventing,
    private readonly logger: ILogger,
    private readonly signal: AbortSignal,
    grpc?: ZeebeGrpc,
  ) {
    this.grpc = grpc ?? (new Camunda8().getZeebeGrpcApiClient() as unknown as ZeebeGrpc);
  }

  // boot: deploy then register the worker; resilient — a broker that is down at boot schedules a retry, never throws up
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.signal.addEventListener("abort", () => void this.stop(), { once: true });
    await this.connect();
  }

  private async connect(): Promise<void> {
    if (this.signal.aborted) return;
    try {
      await this.grpc.topology();
      await this.deployAll();
      this.registerWorker();
      this.logger.info("[workflow] connected to Zeebe; BPMN deployed, worker registered");
    } catch (err) {
      // broker unavailable at boot must not crash the process; back off and retry
      this.scheduleReconnect(err);
    }
  }

  private scheduleReconnect(err: unknown): void {
    if (this.signal.aborted) return;
    const delay = this.cfg.reconnectBaseMs;
    this.logger.warn(`[workflow] Zeebe unavailable (${String(err)}); retrying in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, Math.min(delay, this.cfg.reconnectMaxMs));
  }

  private async deployAll(): Promise<void> {
    const files = readdirSync(this.cfg.bpmnDir).filter((f) => f.endsWith(".bpmn"));
    for (const file of files) {
      await this.grpc.deployResource({ processFilename: join(this.cfg.bpmnDir, file) });
    }
  }

  private registerWorker(): void {
    this.worker = this.grpc.createWorker({
      name: this.cfg.workerName,
      taskType: this.cfg.taskType,
      taskHandler: async (job) => {
        // publish the activated job; agentic execution + completion arrive later via an agent.result event
        this.bus.publish("workflow.job", {
          processInstanceKey: job.processInstanceKey,
          jobKey: job.key,
          jobType: job.type,
          variables: job.variables,
        });
        // agentic dispatch is deferred (M7-3): hold the job open so a future agent.result can complete it out of band
        return job.forward();
      },
    });
  }

  // empty allowlist = unrestricted; a populated list gates starts to its members only
  private isEnabled(bpmnProcessId: string): boolean {
    return this.cfg.enabledProcessIds.length === 0 || this.cfg.enabledProcessIds.includes(bpmnProcessId);
  }

  // start an instance; CAMUNDA owns state, we only record what we started so GET can reflect it
  async startProcess(bpmnProcessId: string, variables: Record<string, unknown> = {}): Promise<InstanceRecord> {
    if (!this.isEnabled(bpmnProcessId)) throw new WorkflowDisabledError(bpmnProcessId);
    const res = await this.grpc.createProcessInstance({ bpmnProcessId, variables });
    const record: InstanceRecord = {
      processInstanceKey: res.processInstanceKey,
      bpmnProcessId,
      status: "active",
      startedAt: Date.now(),
    };
    this.instances.set(record.processInstanceKey, record);
    return record;
  }

  getInstance(processInstanceKey: string): InstanceRecord | undefined {
    return this.instances.get(processInstanceKey);
  }

  // cancel a running instance (the host's stop-work path); CAMUNDA owns state, we just drop our local reflection
  // and let the cancel propagate. throws if the broker rejects it so the caller can record the failure reason.
  async cancelProcess(processInstanceKey: string): Promise<void> {
    await this.grpc.cancelProcessInstance({ processInstanceKey });
    const record = this.instances.get(processInstanceKey);
    if (record) record.status = "failed";
  }

  // operator intervention: inject variables onto a running instance. scopeKey is an element-instance key;
  // pass the processInstanceKey for instance-wide. local=false merges so child scopes inherit them.
  async setVariables(scopeKey: string, variables: Record<string, unknown>, local = false): Promise<void> {
    await this.grpc.setVariables({ elementInstanceKey: scopeKey, variables, local });
  }

  // operator intervention: retry a failed step — bump the job's retries so the broker re-activates it, then
  // clear its incident if one was raised. inert while jobs are forwarded/held (no failure -> no incident)
  async retryJob(jobKey: string, incidentKey?: string, retries = 1): Promise<void> {
    await this.grpc.updateJobRetries({ jobKey, retries });
    if (incidentKey) await this.grpc.resolveIncident({ incidentKey });
  }

  // out-of-band completion seam: a future agent.result event calls this to refresh Camunda state for a held job
  async completeJob(jobKey: string, variables: Record<string, unknown> = {}): Promise<void> {
    await this.grpc.completeJob({ jobKey, variables });
    this.bus.publish("workflow.completed", { processInstanceKey: variables.processInstanceKey });
  }

  get connected(): boolean {
    return this.started && this.worker !== undefined;
  }

  // graceful: stop polling, close the worker, drop the connection; never throws so shutdown keeps unwinding
  async stop(): Promise<void> {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    try {
      await this.worker?.close();
      await this.grpc.close();
    } catch (err) {
      this.logger.warn(`[workflow] error during Zeebe shutdown: ${String(err)}`);
    }
    this.worker = undefined;
    this.started = false;
  }
}
