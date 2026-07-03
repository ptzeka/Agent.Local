import { z } from 'zod';
import { run } from '../runner.js';
import { readState, dataDir } from '../state.js';
import { resolveRepository } from '../config.js';
import { getPipelineRun } from '../azuredevops.js';
import type { ToolDeps } from './registry.js';

export const getStatusShape = {
  repository: z
    .string()
    .min(1)
    .describe(
      'Repository path key, e.g. "org/Project/_git/RepoName". ' +
      'Looked up in the configured repositories map to resolve the Azure DevOps target.',
    ),
};

export interface GetStatusInput {
  repository: string;
}

export async function getStatus(
  input: GetStatusInput,
  deps: ToolDeps,
): Promise<string> {
  const { config, serverDir, adoToken } = deps;
  const adoConfig = resolveRepository(input.repository);
  const state     = readState(dataDir(serverDir));
  const repo      = config.repositoryPath;
  const lines: string[] = [];

  // ── Workflow state ────────────────────────────────────────────────────────
  if (state) {
    lines.push(`feature:     ${state.featureName}`);
    lines.push(`branch:      ${state.branchName}`);
    lines.push(`slug:        ${state.branchSlug}`);
    lines.push(`env:         ${state.envDeployed ? 'deployed' : 'not deployed'}`);
    if (state.prUrl) lines.push(`pr:          ${state.prUrl}`);
  } else {
    lines.push('workflow:    no active feature');
  }

  lines.push(`target:      ${adoConfig.organization}/${adoConfig.project}/${adoConfig.repository}`);
  lines.push('');

  // ── Git working tree ──────────────────────────────────────────────────────
  const currentBranch = await run(`git -C "${repo}" branch --show-current`);
  lines.push(`git branch:  ${currentBranch.stdout || '(detached HEAD)'}`);

  const gitStatus = await run(`git -C "${repo}" status --short`);
  if (gitStatus.stdout) {
    lines.push(`git status:\n${gitStatus.stdout}`);
  } else {
    lines.push('git status:  clean');
  }

  const lastCommit = await run(
    `git -C "${repo}" log -1 --pretty=format:"%h %s (%cr)" HEAD`,
  );
  if (lastCommit.stdout) {
    lines.push(`last commit: ${lastCommit.stdout}`);
  }

  if (!state) return lines.join('\n');

  // ── Pipeline run status ───────────────────────────────────────────────────
  lines.push('');

  if (state.lastDeployRunId) {
    lines.push(`[deploy pipeline]`);
    try {
      const deployRun = await getPipelineRun(
        adoConfig, adoToken,
        config.azureDevOps.pipelines.deployPipelineId,
        state.lastDeployRunId,
      );
      lines.push(`  run #${deployRun.id}  state: ${deployRun.state}  result: ${deployRun.result}`);
      lines.push(`  ${deployRun.webUrl}`);
    } catch (err) {
      lines.push(`  could not query deploy run: ${(err as Error).message}`);
    }
  }

  if (state.lastCiRunId) {
    lines.push(`[CI pipeline]`);
    try {
      const ciRun = await getPipelineRun(
        adoConfig, adoToken,
        config.azureDevOps.pipelines.ciPipelineId,
        state.lastCiRunId,
      );
      lines.push(`  run #${ciRun.id}  state: ${ciRun.state}  result: ${ciRun.result}`);
      lines.push(`  ${ciRun.webUrl}`);
    } catch (err) {
      lines.push(`  could not query CI run: ${(err as Error).message}`);
    }
  }

  return lines.join('\n');
}
