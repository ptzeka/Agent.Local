import type { z } from 'zod';
import type { CodeManagerConfig } from '../config.js';
import { startFeature, startFeatureShape, type StartFeatureInput } from './start_feature.js';
import { pushChanges,  pushChangesShape,  type PushChangesInput  } from './push_changes.js';
import { acceptChanges, acceptChangesShape, type AcceptChangesInput } from './accept_changes.js';
import { abandonChanges, abandonChangesShape, type AbandonChangesInput } from './abandon_changes.js';
import { getStatus, getStatusShape, type GetStatusInput } from './get_status.js';

export interface ToolDeps {
  config: CodeManagerConfig;
  /** Directory holding the running server.js — used for state/data and PAT file resolution. */
  serverDir: string;
  /** Resolved Azure DevOps PAT — read once at server startup. */
  adoToken: string;
}

/**
 * Tool registration record. `inputShape` is a Zod raw shape passed to
 * `McpServer.registerTool` — the SDK wraps it into an object schema and uses it
 * for both JSON Schema generation (for the LLM) and runtime input validation.
 * Handlers receive the validated input directly.
 */
export interface ToolDef {
  name: string;
  description: string;
  inputShape: Record<string, z.ZodTypeAny>;
  handler: (input: never, deps: ToolDeps) => Promise<string>;
}

export const TOOLS: ToolDef[] = [
  {
    name: 'start_feature',
    description:
      'Begin a new feature: syncs main, creates a feature branch, pushes it to Azure DevOps, ' +
      'and triggers the configured deploy pipeline to provision an ephemeral environment. ' +
      'Saves workflow state so subsequent tools know the active branch without being told explicitly.',
    inputShape: startFeatureShape,
    handler: ((input: StartFeatureInput, deps) => startFeature(input, deps)) as ToolDef['handler'],
  },
  {
    name: 'push_changes',
    description:
      'Stage, commit, and push the current working-tree changes to the active feature branch, ' +
      'then trigger the deploy pipeline to redeploy the ephemeral environment. ' +
      'Safe to call multiple times during development. ' +
      'Call start_feature first if no feature is active.',
    inputShape: pushChangesShape,
    handler: ((input: PushChangesInput, deps) => pushChanges(input, deps)) as ToolDef['handler'],
  },
  {
    name: 'accept_changes',
    description:
      'Finalise the feature: ensures the branch is pushed, triggers the delete-env pipeline ' +
      '(if configured), creates an Azure DevOps PR from the feature branch to main, queues the ' +
      'CI pipeline, and waits for it to complete. ' +
      'If CI fails the tool returns the pipeline URL so the agent can read the failure details, ' +
      'fix the code, call push_changes, then accept_changes again — no human input required. ' +
      'When CI passes the PR is ready for the downstream security review gate.',
    inputShape: acceptChangesShape,
    handler: ((input: AcceptChangesInput, deps) => acceptChanges(input, deps)) as ToolDef['handler'],
  },
  {
    name: 'abandon_changes',
    description:
      'Discard the active feature: triggers the delete-env pipeline (if configured), ' +
      'deletes the local and remote feature branch, and clears workflow state. ' +
      'Accepts an optional reason for the audit trail. ' +
      'Includes a safety guard when a PR already exists — pass force=true to override.',
    inputShape: abandonChangesShape,
    handler: ((input: AbandonChangesInput, deps) => abandonChanges(input, deps)) as ToolDef['handler'],
  },
  {
    name: 'get_status',
    description:
      'Return the current workflow state: active feature / branch, git working-tree status, ' +
      'last commit, and live Azure Pipelines run status for the last deploy and CI runs.',
    inputShape: getStatusShape,
    handler: ((input: GetStatusInput, deps) => getStatus(input, deps)) as ToolDef['handler'],
  },
];

export function findTool(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.name === name);
}
