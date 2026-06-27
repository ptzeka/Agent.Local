import {
  userTableTestTemplate,
  userTableFailTestTemplate,
} from "./user-table-test/v1/index.js";
import type { WorkflowTemplate } from "./_shared/template.js";

// this barrel is the worker's single `workflowsPath`: the SDK bundles it (and everything it re-exports) into the
// isolated workflow sandbox, so every startable workflow MUST be re-exported here. Adding a workflow/version = add
// its folder, re-export its fns below, and append its template to the catalog.
export {
  userTableTestWorkflow,
  userTableFailTestWorkflow,
  USER_TABLE_TEST_WORKFLOW_TYPE,
  USER_TABLE_FAIL_TEST_WORKFLOW_TYPE,
} from "./user-table-test/v1/index.js";
export type { UserTableTestArgs } from "./user-table-test/v1/index.js";

export { agentResultSignal, injectSignal } from "./_shared/step-runner.js";
export type { WorkflowTemplate } from "./_shared/template.js";

// the catalog of startable workflows, sourced from code so the console's workflow dropdown is never a hardcoded
// string: each workflow module contributes a template (its Temporal Workflow Type `name` + a UI label). A per-user
// assignment table will gate WHICH templates a caller may start later; for now every registered workflow is offered.
export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [userTableTestTemplate, userTableFailTestTemplate];
