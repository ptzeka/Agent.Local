import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AzureDevOpsConfig } from './config.js';

const ADO_API_VERSION = '7.1';

// ── Auth ─────────────────────────────────────────────────────────────────────

// PAT resolution: AZURE_DEVOPS_TOKEN env var first (CI), then apiKeyFile contents (local dev);
// throws when neither yields a token
export function resolveToken(apiKeyFile: string | undefined, baseDir: string): string {
  const envToken = process.env['AZURE_DEVOPS_TOKEN'];
  if (envToken?.trim()) return envToken.trim();

  if (apiKeyFile) {
    const filePath = resolve(baseDir, apiKeyFile);
    if (!existsSync(filePath)) {
      throw new Error(
        `codemanagermcp: apiKeyFile not found at ${filePath}. ` +
        `Create the file with your Azure DevOps PAT, or set AZURE_DEVOPS_TOKEN env var.`,
      );
    }
    const token = readFileSync(filePath, 'utf-8').trim();
    if (!token) {
      throw new Error(`codemanagermcp: apiKeyFile at ${filePath} is empty.`);
    }
    return token;
  }

  throw new Error(
    'codemanagermcp: no Azure DevOps token available.\n' +
    '  Option 1: set AZURE_DEVOPS_TOKEN environment variable.\n' +
    '  Option 2: add "apiKeyFile": "./secrets/ado-token.txt" to appsettings.json ' +
    'and put your PAT in that file.',
  );
}

function authHeader(token: string): string {
  return 'Basic ' + Buffer.from(`:${token}`).toString('base64');
}

function baseUrl(org: string, project: string): string {
  return `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis`;
}

function pipelineWebUrl(org: string, project: string, runId: number): string {
  return `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_build/results?buildId=${runId}`;
}

async function adoFetch<T>(
  url: string,
  token: string,
  options: RequestInit = {},
): Promise<T> {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: authHeader(token),
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ADO API ${res.status} ${res.statusText}: ${body}`);
  }
  return res.json() as Promise<T>;
}

// ── Pull Requests ─────────────────────────────────────────────────────────────

export interface AdoPrResult {
  prId: number;
  url: string;
  alreadyExists: boolean;
}

interface AdoPrResponse {
  pullRequestId: number;
  _links?: { web?: { href?: string } };
  url?: string;
}

// creates an ADO pull request from head → base; returns the existing PR if one is already open for the branch
export async function createPullRequest(
  adoConfig: AzureDevOpsConfig,
  token: string,
  opts: {
    title: string;
    description: string;
    sourceBranch: string;
    targetBranch: string;
  },
): Promise<AdoPrResult> {
  const url =
    `${baseUrl(adoConfig.organization, adoConfig.project)}` +
    `/git/repositories/${encodeURIComponent(adoConfig.repository)}/pullrequests?api-version=${ADO_API_VERSION}`;

  const body = JSON.stringify({
    title: opts.title,
    description: opts.description,
    sourceRefName: `refs/heads/${opts.sourceBranch}`,
    targetRefName: `refs/heads/${opts.targetBranch}`,
    isDraft: false,
  });

  try {
    const pr = await adoFetch<AdoPrResponse>(url, token, { method: 'POST', body });
    return {
      prId: pr.pullRequestId,
      url: pr._links?.web?.href ?? pr.url ?? buildPrWebUrl(adoConfig, pr.pullRequestId),
      alreadyExists: false,
    };
  } catch (err) {
    const msg = (err as Error).message;
    // TF401179 = PR already exists for this source/target combination
    if (msg.includes('TF401179') || msg.toLowerCase().includes('already exists')) {
      return findExistingPr(adoConfig, token, opts.sourceBranch, opts.targetBranch);
    }
    throw err;
  }
}

function buildPrWebUrl(adoConfig: AzureDevOpsConfig, prId: number): string {
  return (
    `https://dev.azure.com/${encodeURIComponent(adoConfig.organization)}` +
    `/${encodeURIComponent(adoConfig.project)}/_git` +
    `/${encodeURIComponent(adoConfig.repository)}/pullrequest/${prId}`
  );
}

interface AdoPrListResponse {
  value: AdoPrResponse[];
}

async function findExistingPr(
  adoConfig: AzureDevOpsConfig,
  token: string,
  sourceBranch: string,
  targetBranch: string,
): Promise<AdoPrResult> {
  const url =
    `${baseUrl(adoConfig.organization, adoConfig.project)}` +
    `/git/repositories/${encodeURIComponent(adoConfig.repository)}/pullrequests` +
    `?searchCriteria.sourceRefName=${encodeURIComponent(`refs/heads/${sourceBranch}`)}` +
    `&searchCriteria.targetRefName=${encodeURIComponent(`refs/heads/${targetBranch}`)}` +
    `&searchCriteria.status=active&$top=1&api-version=${ADO_API_VERSION}`;

  const data = await adoFetch<AdoPrListResponse>(url, token);
  const pr = data.value[0];
  if (!pr) {
    throw new Error('ADO reported duplicate PR but none found in the active list.');
  }
  return {
    prId: pr.pullRequestId,
    url: pr._links?.web?.href ?? buildPrWebUrl(adoConfig, pr.pullRequestId),
    alreadyExists: true,
  };
}

// ── Pipelines ─────────────────────────────────────────────────────────────────

export type PipelineRunState = 'unknown' | 'inProgress' | 'completed';
export type PipelineRunResult = 'unknown' | 'succeeded' | 'failed' | 'canceled';

export interface PipelineRun {
  id: number;
  state: PipelineRunState;
  result: PipelineRunResult;
  // web URL to view the run in Azure DevOps
  webUrl: string;
}

interface AdoPipelineRunResponse {
  id: number;
  state: string;
  result: string;
  _links?: { web?: { href?: string } };
}

// queues a pipeline run, passing BRANCH_NAME, BRANCH_SLUG, and FEATURE_NAME as pipeline variables
export async function queuePipelineRun(
  adoConfig: AzureDevOpsConfig,
  token: string,
  pipelineId: number,
  vars: { branchName: string; branchSlug: string; featureName: string },
): Promise<PipelineRun> {
  const url =
    `${baseUrl(adoConfig.organization, adoConfig.project)}` +
    `/pipelines/${pipelineId}/runs?api-version=${ADO_API_VERSION}`;

  const body = JSON.stringify({
    resources: {
      repositories: {
        self: { refName: `refs/heads/${vars.branchName}` },
      },
    },
    variables: {
      BRANCH_NAME:  { value: vars.branchName,  isSecret: false },
      BRANCH_SLUG:  { value: vars.branchSlug,  isSecret: false },
      FEATURE_NAME: { value: vars.featureName, isSecret: false },
    },
  });

  const run = await adoFetch<AdoPipelineRunResponse>(url, token, { method: 'POST', body });
  return normalisePipelineRun(adoConfig, pipelineId, run);
}

// fetches the current status of a pipeline run
export async function getPipelineRun(
  adoConfig: AzureDevOpsConfig,
  token: string,
  pipelineId: number,
  runId: number,
): Promise<PipelineRun> {
  const url =
    `${baseUrl(adoConfig.organization, adoConfig.project)}` +
    `/pipelines/${pipelineId}/runs/${runId}?api-version=${ADO_API_VERSION}`;

  const run = await adoFetch<AdoPipelineRunResponse>(url, token);
  return normalisePipelineRun(adoConfig, pipelineId, run);
}

function normalisePipelineRun(
  adoConfig: AzureDevOpsConfig,
  pipelineId: number,
  raw: AdoPipelineRunResponse,
): PipelineRun {
  return {
    id: raw.id,
    state: (raw.state ?? 'unknown') as PipelineRunState,
    result: (raw.result ?? 'unknown') as PipelineRunResult,
    webUrl:
      raw._links?.web?.href ??
      pipelineWebUrl(adoConfig.organization, adoConfig.project, raw.id),
  };

  void pipelineId;
}

// polls until the run reaches `completed` or timeoutMs elapses (default 15 min, poll every 15 s),
// then returns the final or last-known status
export async function waitForPipelineRun(
  adoConfig: AzureDevOpsConfig,
  token: string,
  pipelineId: number,
  runId: number,
  pollIntervalMs = 15_000,
  timeoutMs = 15 * 60 * 1_000,
): Promise<PipelineRun> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const run = await getPipelineRun(adoConfig, token, pipelineId, runId);
    if (run.state === 'completed') return run;
    await sleep(Math.min(pollIntervalMs, deadline - Date.now()));
  }

  // on timeout, return the last known state (still inProgress)
  return getPipelineRun(adoConfig, token, pipelineId, runId);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
