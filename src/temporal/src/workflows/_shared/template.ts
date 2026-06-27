// the catalog descriptor a workflow contributes so the console's dropdown is sourced from code, never a hardcoded
// string. Lives in _shared (not the barrel) so a versioned workflow can type its own template export without a
// cycle back through the aggregating index.
export interface WorkflowTemplate {
  name: string; // the Temporal Workflow Type the host starts (TemporalClient.startProcess); must match a registered workflow
  label: string; // human-facing text for the dropdown
}
