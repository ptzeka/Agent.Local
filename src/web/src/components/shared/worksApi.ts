// typed client over the host's user-scoped work API (/api/works), bound to the shared axios instance.
// the session cookie rides same-origin (withCredentials), so the host scopes every call to the logged-in user.
import { useMemo } from "react";
import type { AxiosInstance } from "axios";
import { useApiClient } from "@/providers/api_context";

// mirrors the host's WorkRecord (src/host/src/work/work-store.ts); the wire shape the work table renders.
// step carries the descriptive "where we are" (it absorbed the old statusDescription: stop/failure reasons too).
export interface WorkRecord {
  workId: string;
  userId: string;
  workflowId: string | null;
  workspaceId: string | null;
  status: "new" | "running" | "stopped" | "completed";
  step: string | null;
  sessionId: string | null;
  temporalId: string | null;
  createdAt: string;
  ts: string;
}

// mirrors the temporal package's WorkflowStep (src/temporal/src/temporal-client.ts) — one reconstructed step of a
// work's run. `status` is the engine's own activity status, distinct from the overall work status catalog below.
export interface WorkflowStep {
  id: string;
  name: string;
  status: "scheduled" | "running" | "completed" | "failed" | "timedOut" | "canceled";
  parentId: string | null;
  startedAt: string;
  detail: string | null;
  // the step's intent decoded from the activity input (the dispatched prompt); null when none. `name` stays
  // the activity type — this is what differentiates otherwise-identical steps in the accordion.
  description: string | null;
}

// mirrors the host's StatusCode (src/host/src/work/work-status.ts) — the status catalog the UI renders from.
// `tone` is presentation-neutral (the page maps it to a chip color); the flags drive the per-row action gating.
export interface StatusCode {
  status: string;
  label: string;
  tone: "neutral" | "active" | "warn" | "error" | "success";
  terminal: boolean;
  stoppable: boolean;
  continuable: boolean;
}

// mirrors the host's WorkflowTemplate (src/temporal/src/workflows/index.ts) — one startable workflow the
// console offers in its Start dropdown. `name` is the Temporal Workflow Type passed back to createWork.
export interface WorkflowTemplate {
  name: string;
  label: string;
}

export interface WorksApi {
  getWorkflows(): Promise<WorkflowTemplate[]>;
  getStatusCodes(): Promise<StatusCode[]>;
  searchWorks(status?: string): Promise<WorkRecord[]>;
  getWork(workId: string): Promise<{ work: WorkRecord; steps: WorkflowStep[]; stepsError: string | null }>;
  createWork(workflowId: string): Promise<string>;
  rerunStep(workId: string, stepId: string): Promise<WorkRecord>;
  stopWork(workId: string, reason?: string): Promise<WorkRecord>;
  continueWork(workId: string): Promise<WorkRecord>;
}

// binds the typed work methods to one axios instance; the response interceptor already throws on non-2xx,
// so each method just unwraps the typed body. Pure factory — no React, reusable from any caller.
export function createWorksApi(client: AxiosInstance): WorksApi {
  return {
    // the startable workflow catalog from the host (sourced from code, not hardcoded), so the Start dropdown
    // reflects exactly what the worker can run. Fetched once on page load.
    async getWorkflows() {
      const { data } = await client.get<{ workflows: WorkflowTemplate[] }>("/api/works/workflows");
      return data.workflows;
    },

    // the status catalog (labels, tone, action flags) from the host lookup table; fetched once so the table
    // renders status presentation and gates row actions from data rather than hardcoded conditionals
    async getStatusCodes() {
      const { data } = await client.get<{ statusCodes: StatusCode[] }>("/api/works/statuscodes");
      return data.statusCodes;
    },

    // search the caller's works, newest-first; optional status filter (e.g. "running")
    async searchWorks(status?: string) {
      const { data } = await client.get<{ works: WorkRecord[] }>("/api/works", {
        params: status ? { status } : undefined,
      });
      return data.works;
    },

    // current state of one work the caller owns plus its reconstructed step history (folded into the same GET);
    // throws on 404 (not found / not yours). steps is [] when the work hasn't started; stepsError carries the
    // reason when Temporal was reachable but the history read failed, so the UI distinguishes that from truly-empty.
    async getWork(workId: string) {
      const { data } = await client.get<{ work: WorkRecord; steps: WorkflowStep[]; stepsError: string | null }>(
        `/api/works/${encodeURIComponent(workId)}`,
      );
      return data;
    },

    // create (start) a work by workflow type; returns the new workId the caller queries by
    async createWork(workflowId: string) {
      const { data } = await client.post<{ workId: string }>("/api/works", { workflowId });
      return data.workId;
    },

    // rerun a work from a chosen step (engine Reset): re-runs that step and everything after, dropping old answers.
    // returns the updated record (status "running"). the caller gates this to settled works — the engine refuses a live run.
    async rerunStep(workId: string, stepId: string) {
      const { data } = await client.post<{ work: WorkRecord }>(
        `/api/works/${encodeURIComponent(workId)}/steps/${encodeURIComponent(stepId)}/rerun`,
        {},
      );
      return data.work;
    },

    // stop a work the caller owns; returns its updated record (status "stopped")
    async stopWork(workId: string, reason?: string) {
      const { data } = await client.post<{ work: WorkRecord }>(
        `/api/works/${encodeURIComponent(workId)}/stop`,
        { reason },
      );
      return data.work;
    },

    // continue (pick a stopped work back up — re-execute its last step) the caller owns; returns its updated record
    // (status "running"). only a `stopped` work is resettable — the host answers 409 otherwise, thrown by the interceptor.
    async continueWork(workId: string) {
      const { data } = await client.post<{ work: WorkRecord }>(
        `/api/works/${encodeURIComponent(workId)}/continue`,
        {},
      );
      return data.work;
    },
  };
}

// hook seam: the bound works api, memoized against the shared client so consumers get a stable reference
export function useWorksApi(): WorksApi {
  const client = useApiClient();
  return useMemo(() => createWorksApi(client), [client]);
}
