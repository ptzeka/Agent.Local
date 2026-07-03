import { z } from 'zod';
import { mustRun } from '../runner.js';
import { writeState, dataDir } from '../state.js';
import { featureBranch, resolveRepository, slugify } from '../config.js';
import { queuePipelineRun } from '../azuredevops.js';
import type { ToolDeps } from './registry.js';

export const startFeatureShape = {
  repository: z
    .string()
    .min(1)
    .describe(
      'Repository path key, e.g. "org/Project/_git/RepoName". ' +
      'Looked up in the configured repositories map to resolve the Azure DevOps target.',
    ),
  name: z
    .string()
    .min(1)
    .describe(
      'Short human-readable feature name (e.g. "add user auth"). ' +
      'Automatically slugified into a safe branch name.',
    ),
};

export interface StartFeatureInput {
  repository: string;
  name: string;
}

export async function startFeature(
  input: StartFeatureInput,
  deps: ToolDeps,
): Promise<string> {
  const { config, serverDir, adoToken } = deps;
  const adoConfig   = resolveRepository(input.repository);
  const featureName = input.name;
  const branchSlug  = slugify(featureName);

  if (!branchSlug) {
    throw new Error(`"${featureName}" produces an empty slug — use alphanumeric characters.`);
  }

  const branchName = featureBranch(branchSlug);
  const repo       = config.repositoryPath;
  const lines: string[] = [];

  lines.push(`feature: ${featureName}`);
  lines.push(`branch:  ${branchName}`);
  lines.push(`slug:    ${branchSlug}`);
  lines.push(`target:  ${adoConfig.organization}/${adoConfig.project}/${adoConfig.repository}`);
  lines.push('');

  // ── Git: sync main and create branch ─────────────────────────────────────
  lines.push(`[git] checkout ${config.mainBranch}`);
  await mustRun(`git -C "${repo}" checkout ${config.mainBranch}`);

  lines.push(`[git] pull origin ${config.mainBranch}`);
  await mustRun(`git -C "${repo}" pull origin ${config.mainBranch}`);

  lines.push(`[git] checkout -b ${branchName}`);
  await mustRun(`git -C "${repo}" checkout -b ${branchName}`);

  // ── Push branch so Azure Pipelines can see it ─────────────────────────────
  lines.push(`[git] push -u origin ${branchName}`);
  await mustRun(`git -C "${repo}" push -u origin ${branchName}`);

  // ── Trigger deploy pipeline ───────────────────────────────────────────────
  const pipelineId = config.azureDevOps.pipelines.deployPipelineId;
  lines.push(`[pipeline] queue deploy pipeline #${pipelineId}`);

  const run = await queuePipelineRun(
    adoConfig,
    adoToken,
    pipelineId,
    { branchName, branchSlug, featureName },
  );

  lines.push(`[pipeline] queued run #${run.id} — ${run.webUrl}`);

  // ── Persist state ─────────────────────────────────────────────────────────
  writeState(dataDir(serverDir), {
    featureName,
    branchName,
    branchSlug,
    envDeployed: true,
    lastDeployRunId: run.id,
  });

  lines.push('');
  lines.push(`✓ Feature started.`);
  lines.push(`  Branch "${branchName}" created and pushed.`);
  lines.push(`  Deploy pipeline running: ${run.webUrl}`);
  lines.push(`  Next: make changes, then call push_changes to commit and redeploy.`);

  return lines.join('\n');
}
