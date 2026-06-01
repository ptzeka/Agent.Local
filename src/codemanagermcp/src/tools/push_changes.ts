import { z } from 'zod';
import { run, mustRun } from '../runner.js';
import { readState, patchState, dataDir } from '../state.js';
import { resolveRepository, slugify } from '../config.js';
import { queuePipelineRun } from '../azuredevops.js';
import type { ToolDeps } from './registry.js';

export const pushChangesShape = {
  repository: z
    .string()
    .min(1)
    .describe(
      'Repository path key, e.g. "org/Project/_git/RepoName". ' +
      'Looked up in the configured repositories map to resolve the Azure DevOps target.',
    ),
  message: z
    .string()
    .optional()
    .describe('Commit message. Defaults to "wip: {branchSlug}" when omitted.'),
  stageAll: z
    .boolean()
    .optional()
    .default(true)
    .describe('Stage all changes (git add -A) before committing. Default: true.'),
};

export interface PushChangesInput {
  repository: string;
  message?: string;
  stageAll?: boolean;
}

export async function pushChanges(
  input: PushChangesInput,
  deps: ToolDeps,
): Promise<string> {
  const { config, serverDir, adoToken } = deps;
  const adoConfig = resolveRepository(input.repository);
  const state     = readState(dataDir(serverDir));
  if (!state) {
    throw new Error('No active feature. Call start_feature first.');
  }

  const { branchName, branchSlug, featureName } = state;
  const repo  = config.repositoryPath;
  const lines: string[] = [];

  lines.push(`feature: ${featureName}`);
  lines.push(`branch:  ${branchName}`);
  lines.push(`target:  ${adoConfig.organization}/${adoConfig.project}/${adoConfig.repository}`);
  lines.push('');

  // ── Ensure we are on the right branch ────────────────────────────────────
  const currentBranch = await run(`git -C "${repo}" branch --show-current`);
  if (currentBranch.stdout !== branchName) {
    lines.push(`[warn] current branch "${currentBranch.stdout}" ≠ "${branchName}". Switching.`);
    await mustRun(`git -C "${repo}" checkout ${branchName}`);
  }

  // ── Stage ─────────────────────────────────────────────────────────────────
  const stageAll = input.stageAll ?? true;
  if (stageAll) {
    lines.push('[git] add -A');
    await mustRun(`git -C "${repo}" add -A`);
  }

  // ── Commit if there is anything staged ───────────────────────────────────
  const statusResult  = await run(`git -C "${repo}" status --porcelain`);
  const hasChanges    = statusResult.stdout.length > 0;

  if (hasChanges) {
    const message = input.message ?? `wip: ${branchSlug}`;
    lines.push(`[git] commit -m "${message}"`);
    await mustRun(`git -C "${repo}" commit -m "${message.replace(/"/g, '\\"')}"`);
  } else {
    lines.push('[git] nothing to commit — skipping commit step');
  }

  // ── Push ──────────────────────────────────────────────────────────────────
  lines.push(`[git] push -u origin ${branchName}`);
  const pushResult = await mustRun(`git -C "${repo}" push -u origin ${branchName}`);
  if (pushResult.stderr) lines.push(pushResult.stderr);

  // ── Trigger deploy pipeline ───────────────────────────────────────────────
  const pipelineId = config.azureDevOps.pipelines.deployPipelineId;
  lines.push(`[pipeline] queue deploy pipeline #${pipelineId}`);

  const run2 = await queuePipelineRun(
    adoConfig,
    adoToken,
    pipelineId,
    { branchName, branchSlug: branchSlug ?? slugify(featureName), featureName },
  );

  lines.push(`[pipeline] queued run #${run2.id} — ${run2.webUrl}`);

  patchState(dataDir(serverDir), { envDeployed: true, lastDeployRunId: run2.id });

  lines.push('');
  lines.push(
    hasChanges
      ? `✓ Changes committed and pushed to "${branchName}". Deploy pipeline queued.`
      : `✓ Pushed (no new commit). Deploy pipeline queued.`,
  );
  lines.push(`  Deploy: ${run2.webUrl}`);
  lines.push(`  Next: call accept_changes to open a PR and run CI, or push more changes.`);

  return lines.join('\n');
}
