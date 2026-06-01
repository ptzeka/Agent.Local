import { z } from 'zod';
import { run } from '../runner.js';
import { readState, clearState, dataDir } from '../state.js';
import { resolveRepository, slugify } from '../config.js';
import { queuePipelineRun } from '../azuredevops.js';
import type { ToolDeps } from './registry.js';

export const abandonChangesShape = {
  repository: z
    .string()
    .min(1)
    .describe(
      'Repository path key, e.g. "org/Project/_git/RepoName". ' +
      'Looked up in the configured repositories map to resolve the Azure DevOps target.',
    ),
  force: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      'Skip the safety guard that prevents abandoning when a PR already exists. Default: false.',
    ),
  reason: z
    .string()
    .optional()
    .describe('Optional reason for the audit log.'),
};

export interface AbandonChangesInput {
  repository: string;
  force?: boolean;
  reason?: string;
}

export async function abandonChanges(
  input: AbandonChangesInput,
  deps: ToolDeps,
): Promise<string> {
  const { config, serverDir, adoToken } = deps;
  const adoConfig = resolveRepository(input.repository);
  const state     = readState(dataDir(serverDir));
  if (!state) {
    return 'No active feature to abandon. State is already clear.';
  }

  const { branchName, branchSlug, featureName, prUrl, envDeployed } = state;
  const slug  = branchSlug ?? slugify(featureName);
  const force = input.force ?? false;
  const repo  = config.repositoryPath;
  const lines: string[] = [];

  lines.push(`feature: ${featureName}`);
  lines.push(`branch:  ${branchName}`);
  lines.push(`target:  ${adoConfig.organization}/${adoConfig.project}/${adoConfig.repository}`);
  if (input.reason) lines.push(`reason:  ${input.reason}`);
  lines.push('');

  // ── Safety guard ──────────────────────────────────────────────────────────
  if (prUrl && !force) {
    lines.push(
      `SAFETY: an open PR exists at ${prUrl}.\n` +
      `Pass force=true to abandon anyway. The PR will remain open in Azure DevOps — abandon it there manually.`,
    );
    return lines.join('\n');
  }

  // ── Tear down deploy environment ──────────────────────────────────────────
  const deletePipelineId = config.azureDevOps.pipelines.deletePipelineId;

  if (envDeployed && deletePipelineId) {
    lines.push(`[pipeline] queue delete-env pipeline #${deletePipelineId}`);
    try {
      const delRun = await queuePipelineRun(
        adoConfig, adoToken, deletePipelineId,
        { branchName, branchSlug: slug, featureName },
      );
      lines.push(`[pipeline] teardown queued: ${delRun.webUrl}`);
    } catch (err) {
      lines.push(`[warn] teardown pipeline failed to queue: ${(err as Error).message}. Continuing cleanup.`);
    }
  } else if (envDeployed && !deletePipelineId) {
    lines.push('[env] no deletePipelineId configured — skipping environment teardown.');
  } else {
    lines.push('[env] environment was not deployed — nothing to tear down.');
  }

  // ── Return to main branch ─────────────────────────────────────────────────
  lines.push(`[git] checkout ${config.mainBranch}`);
  const checkoutResult = await run(`git -C "${repo}" checkout ${config.mainBranch}`);
  if (checkoutResult.exitCode !== 0) {
    lines.push(`[warn] checkout failed: ${checkoutResult.stderr}`);
  }

  // ── Delete local branch ───────────────────────────────────────────────────
  lines.push(`[git] branch -D ${branchName}`);
  const localDelete = await run(`git -C "${repo}" branch -D ${branchName}`);
  if (localDelete.exitCode !== 0) {
    lines.push(`[warn] local delete: ${localDelete.stderr || localDelete.stdout}`);
  }

  // ── Delete remote branch (best-effort; ADO also auto-deletes on PR close) ─
  lines.push(`[git] push origin --delete ${branchName}`);
  const remoteDelete = await run(`git -C "${repo}" push origin --delete ${branchName}`);
  if (remoteDelete.exitCode !== 0) {
    lines.push(
      `[warn] remote branch delete exited ${remoteDelete.exitCode}: ` +
      `${remoteDelete.stderr || remoteDelete.stdout}`,
    );
  }

  // ── Clear state ───────────────────────────────────────────────────────────
  clearState(dataDir(serverDir));

  lines.push('');
  lines.push(`✓ Feature "${featureName}" abandoned. Branch and environment cleaned up.`);
  lines.push('  Call start_feature to begin a new feature.');

  return lines.join('\n');
}
