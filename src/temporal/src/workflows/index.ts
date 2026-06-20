import { userTableTestTemplate } from "./user-table-test.js";

// the catalog of startable workflows, sourced from code so the console's workflow dropdown is never a hardcoded
// string: each workflow module contributes a template (its Temporal Workflow Type `name` + a UI label). A
// per-user assignment table will gate WHICH templates a caller may start later; for now every registered
// workflow is offered. Adding a workflow = add its descriptor to this array (and register it in the worker).
export interface WorkflowTemplate {
  name: string; // the Temporal Workflow Type the host starts (TemporalClient.startProcess); must match a registered workflow
  label: string; // human-facing text for the dropdown
}

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [userTableTestTemplate];
