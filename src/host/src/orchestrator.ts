import { randomUUID } from "node:crypto";
import type { Eventing, ILogger } from "@agent-local/common";
import {
  WORKFLOW_START,
  WORKFLOW_STARTED,
  WORKFLOW_STOP,
  WORKFLOW_COMPLETED,
  WORKFLOW_FAILED,
  type WorkflowStartedPayload,
  type WorkflowCompletedPayload,
  type WorkflowFailedPayload,
} from "./events.js";
import type { JobRecord } from "./jobs/job-registry.js";
import type { JobRegistry } from "./jobs/job-registry.js";
import type { AgentClient } from "./comms/sender.js";

// owns the work unit's lifecycle: the join no single engine holds. trigger() provisions it up front (mint
// ids -> open the agent session -> command the start), then the bus updaters fold each engine event back
// onto the registry. Couples to the engines ONLY through the bus, except ctx.jobs which IS the host's state.
export class Orchestrator {
  constructor(
    private readonly bus: Eventing,
    private readonly jobs: JobRegistry,
    private readonly agent: AgentClient,
    private readonly logger: ILogger,
  ) {}

  // wire the registry updaters: camunda live -> store camundaId; terminal -> close the session, set status
  start(): void {
    this.bus.subscribe(WORKFLOW_STARTED, (event) => {
      const { workId, camundaId } = event.payload as unknown as WorkflowStartedPayload;
      void this.jobs.update(workId, { camundaId, status: "running" });
    });

    this.bus.subscribe(WORKFLOW_COMPLETED, (event) => {
      const { processInstanceKey } = event.payload as unknown as WorkflowCompletedPayload;
      void this.finish(processInstanceKey, "completed");
    });

    this.bus.subscribe(WORKFLOW_FAILED, (event) => {
      const { processInstanceKey } = event.payload as unknown as WorkflowFailedPayload;
      if (processInstanceKey) void this.finish(processInstanceKey, "error");
    });
  }

  // provisions a new work unit owned by userId and commands its start; returns the workId the caller queries by.
  // the agent session is opened under the host's OWN agent:trigger service token (see HttpJobSender), not the caller's.
  async trigger(workflowId: string, userId: string): Promise<string> {
    const workId = randomUUID();
    const workspaceId = randomUUID();
    await this.jobs.add(workId, userId, workflowId);
    const sessionId = await this.agent.createSession(workspaceId, workId);
    await this.jobs.update(workId, { sessionId });
    this.bus.publish(WORKFLOW_START, { workId, workspaceId, sessionId, workflowId });
    return workId;
  }

  // stops a work the caller owns: cancel the camunda instance (bus -> engine), shut the agent session, and
  // record `stopped` with a reason. Tolerant by design — a down broker or already-closed session must not block
  // the stop, so the camunda cancel rides the bus (fire-and-forget) and closeSession swallows its own errors.
  async stop(workId: string, userId: string, reason: string): Promise<JobRecord | null> {
    const record = await this.jobs.get(workId);
    if (!record || record.userId !== userId) return null;
    if (record.camundaId) this.bus.publish(WORKFLOW_STOP, { workId, camundaId: record.camundaId });
    if (record.sessionId) await this.agent.closeSession(record.sessionId);
    return this.jobs.update(workId, { status: "stopped", reason });
  }

  // terminal fold: resolve the work unit by its camundaId, close its session, and record the final status
  private async finish(camundaId: string, status: "completed" | "error"): Promise<void> {
    const record = (await this.jobs.search()).find((r) => r.camundaId === camundaId);
    if (!record) return;
    if (record.sessionId) await this.agent.closeSession(record.sessionId);
    await this.jobs.update(record.jobId, { status });
  }
}
