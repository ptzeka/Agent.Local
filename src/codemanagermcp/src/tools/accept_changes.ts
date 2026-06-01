import { z } from 'zod';
import { run } from '../runner.js';
import { readState, patchState, dataDir } from '../state.js';
import { resolveRepository, slugify } from '../config.js';
import {
  createPullRequest,
  queuePipelineRun,
  waitForPipelineRun,
} from '../azuredevops.js';
import type { ToolDeps } from './registry.js';

export const acceptChangesShape = {
  repository: z
    .string()
    .min(1)
    .describe(
      'Repository path key, e.g. "org/Project/_git/RepoName". ' +
      'Looked up in the configured repositories map to resolve the Azure DevOps target.',
    ),
  title: z
    .string()
    .optional()
    .describe('PR title. Defaults to "feat: {branchSlug}" when omitted.'),
  description: z
    .string()
    .optional()
    .describe('PR description. Defaults to a brief generated summary.'),
};

export interface AcceptChangesInput {
  repository: string;
  title?: string;
  description?: string;
}

export async function acceptChanges(
  input: AcceptChangesInput,
  deps: ToolDeps,
): Promise<string> {
  const { config, serverDir, adoToken } = deps;
  const adoConfig = resolveRepository(input.repository);
  const state     = readState(dataDir(serverDir));
  if (!state) {
    throw new Error('No active feature. Call start_feature first.');
  }

  const { branchName, branchSlug, featureName } = state;
  const slug = branchSlug ?? slugify(featureName);
  const repo = config.repositoryPath;
  const lines: string[] = [];

  lines.push(`feature: ${featureName}`);
  lines.push(`branch:  ${branchName} → ${config.mainBranch}`);
  lines.push(`target:  ${adoConfig.organization}/${adoConfig.project}/${adoConfig.repository}`);
  lines.push('');

  // ── Ensure latest is pushed ───────────────────────────────────────────────
  lines.push(`[git] push -u origin ${branchName}`);
  const pushResult = await run(`git -C "${repo}" push -u origin ${branchName}`);
  if (pushResult.exitCode !== 0 && !pushResult.stderr.includes('Everything up-to-date')) {
    lines.push(`[warn] push: ${pushResult.stderr || pushResult.stdout}`);
  }

  // ── Tear down deploy environment (fire-and-forget) ────────────────────────
  const deletePipelineId = config.azureDevOps.pipelines.deletePipelineId;
  if (deletePipelineId && state.envDeployed) {
    lines.push(`[pipeline] queue delete-env pipeline #${deletePipelineId}`);
    try {
      const delRun = await queuePipelineRun(
        adoConfig, adoToken, deletePipelineId,
        { branchName, branchSlug: slug, featureName },
      );
      lines.push(`[pipeline] teardown queued: ${delRun.webUrl}`);
      patchState(dataDir(serverDir), { envDeployed: false });
    } catch (err) {
      lines.push(`[warn] teardown pipeline failed to queue: ${(err as Error).message}`);
    }
  }

  // ── Create Pull Request ───────────────────────────────────────────────────
  lines.push('');
  const prTitle = input.title ?? `feat: ${slug}`;
  const prDescription =
    input.description ??
    `Automated PR for feature **${featureName}**.\n\nBranch: \`${branchName}\``;

  try {
    const pr = await createPullRequest(
      adoConfig,
      adoToken,
      {
        title: prTitle,
        description: prDescription,
        sourceBranch: branchName,
        targetBranch: config.mainBranch,
      },
    );

    patchState(dataDir(serverDir), { prId: pr.prId, prUrl: pr.url });

    lines.push(
      pr.alreadyExists
        ? `[pr] existing PR #${pr.prId}: ${pr.url}`
        : `[pr] created PR #${pr.prId}: ${pr.url}`,
    );
  } catch (err) {
    lines.push(`[pr] WARN: could not create PR — ${(err as Error).message}`);
  }

  // ── Queue CI pipeline and wait ────────────────────────────────────────────
  lines.push('');
  const ciPipelineId = config.azureDevOps.pipelines.ciPipelineId;
  const timeoutMs    = (config.azureDevOps.pipelines.ciTimeoutMinutes ?? 15) * 60 * 1_000;

  lines.push(`[pipeline] queue CI pipeline #${ciPipelineId}`);
  const ciRun = await queuePipelineRun(
    adoConfig, adoToken, ciPipelineId,
    { branchName, branchSlug: slug, featureName },
  );
  lines.push(`[pipeline] CI run #${ciRun.id} started — ${ciRun.webUrl}`);
  patchState(dataDir(serverDir), { lastCiRunId: ciRun.id });

  lines.push(`[pipeline] waiting for CI (timeout: ${config.azureDevOps.pipelines.ciTimeoutMinutes ?? 15} min)…`);
  const finalRun = await waitForPipelineRun(
    adoConfig, adoToken, ciPipelineId, ciRun.id,
    15_000,
    timeoutMs,
  );

  // ── Evaluate CI result ────────────────────────────────────────────────────
  lines.push('');

  if (finalRun.state !== 'completed') {
    lines.push(`CI pipeline still running after timeout: ${finalRun.webUrl}`);
    lines.push('Call get_status to check current pipeline state, or open the URL above.');
    return lines.join('\n');
  }

  if (finalRun.result !== 'succeeded') {
    lines.push(`CI FAILED (result: ${finalRun.result})`);
    lines.push(`Pipeline run: ${finalRun.webUrl}`);
    lines.push('');
    lines.push(
      'Action required: open the pipeline URL above to read the failure details. ' +
      'Fix the failing tests or build errors, then call push_changes and accept_changes again.',
    );
    return lines.join('\n');
  }

  // ── All green ─────────────────────────────────────────────────────────────
  lines.push('✓ CI pipeline succeeded.');

  const latestState = readState(dataDir(serverDir));
  if (latestState?.prUrl) {
    lines.push(`✓ PR ready for review: ${latestState.prUrl}`);
  }

  lines.push(
    '  Next: the PR is now ready for the downstream security review gate. ' +
    'Call abandon_changes only if the feature is being scrapped.',
  );

  return lines.join('\n');
}
