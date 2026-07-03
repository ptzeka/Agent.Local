import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import appSettings from './appsettings.json' with { type: 'json' };

// ── Sub-configs ───────────────────────────────────────────────────────────────

export interface RepositoryMapping {
  // Azure DevOps organisation name
  org: string;
  // team project name
  project: string;
  // repository name as shown in Azure DevOps
  repository: string;
}

export interface AzureDevOpsConfig {
  organization: string;
  project: string;
  repository: string;
  // plain-text PAT file for local dev, resolved relative to server.js's dir;
  // falls back to the AZURE_DEVOPS_TOKEN env var when absent
  apiKeyFile?: string;
}

export interface PipelinesConfig {
  deployPipelineId: number;
  deletePipelineId?: number;
  ciPipelineId: number;
  ciTimeoutMinutes?: number;
}

export interface AzureDevOpsSection {
  apiKeyFile?: string;
  pipelines: PipelinesConfig;
  // maps consumer-provided repository keys (e.g. "org/Project/_git/Repo") to their ADO target
  repositories: Record<string, RepositoryMapping>;
}

// ── Top-level config ──────────────────────────────────────────────────────────

export interface CodeManagerConfig {
  // absolute path to the local git repository clone
  repositoryPath: string;
  mainBranch: string;
  branchPrefix: string;
  azureDevOps: AzureDevOpsSection;
}

// ── Defaults ──────────────────────────────────────────────────────────────────

const DEFAULTS = {
  mainBranch: 'main',
  branchPrefix: 'feat/',
  ciTimeoutMinutes: 15,
};

// ── Raw shape (partial — validated below) ─────────────────────────────────────

interface RawPipelines {
  deployPipelineId?: number;
  deletePipelineId?: number;
  ciPipelineId?: number;
  ciTimeoutMinutes?: number;
}

interface RawRepository {
  org?: string;
  project?: string;
  repository?: string;
}

interface RawAzureDevOps {
  apiKeyFile?: string;
  pipelines?: RawPipelines;
  repositories?: Record<string, RawRepository>;
}

interface RawConfig {
  repositoryPath?: string;
  mainBranch?: string;
  branchPrefix?: string;
  azureDevOps?: RawAzureDevOps;
}

// ── Build the validated config ────────────────────────────────────────────────

function build(): CodeManagerConfig {
  const raw = appSettings as RawConfig;

  if (!raw.repositoryPath) {
    throw new Error('codemanagermcp: appsettings.json is missing "repositoryPath".');
  }

  const ado = raw.azureDevOps;
  if (!ado) {
    throw new Error('codemanagermcp: appsettings.json is missing the "azureDevOps" section.');
  }

  const pipes = ado.pipelines;
  if (!pipes?.deployPipelineId || !pipes?.ciPipelineId) {
    throw new Error(
      'codemanagermcp: appsettings.json is missing "azureDevOps.pipelines.deployPipelineId" or "azureDevOps.pipelines.ciPipelineId".',
    );
  }

  const rawRepos = ado.repositories ?? {};
  const repoKeys = Object.keys(rawRepos);
  if (repoKeys.length === 0) {
    throw new Error(
      'codemanagermcp: appsettings.json "azureDevOps.repositories" map is empty — add at least one entry.',
    );
  }

  const repositories: Record<string, RepositoryMapping> = {};
  for (const key of repoKeys) {
    const r = rawRepos[key];
    if (!r?.org || !r?.project || !r?.repository) {
      throw new Error(
        `codemanagermcp: azureDevOps.repositories["${key}"] is missing "org", "project", or "repository".`,
      );
    }
    repositories[key] = {
      org: r.org,
      project: r.project,
      repository: r.repository,
    };
  }

  return {
    repositoryPath: resolve(raw.repositoryPath),
    mainBranch:   raw.mainBranch   ?? DEFAULTS.mainBranch,
    branchPrefix: raw.branchPrefix ?? DEFAULTS.branchPrefix,
    azureDevOps: {
      apiKeyFile: ado.apiKeyFile,
      pipelines: {
        deployPipelineId: pipes.deployPipelineId,
        deletePipelineId: pipes.deletePipelineId,
        ciPipelineId:     pipes.ciPipelineId,
        ciTimeoutMinutes: pipes.ciTimeoutMinutes ?? DEFAULTS.ciTimeoutMinutes,
      },
      repositories,
    },
  };
}

export const config: CodeManagerConfig = build();

// directory holding the running server.js — used for PAT file resolution and the data/ state subfolder
export const serverDir: string = dirname(fileURLToPath(import.meta.url));

// ── Repository resolution ─────────────────────────────────────────────────────

// resolves a consumer-provided repository key into its ADO target; throws when the key is unknown
export function resolveRepository(key: string): AzureDevOpsConfig {
  const entry = config.azureDevOps.repositories[key];
  if (!entry) {
    const known = Object.keys(config.azureDevOps.repositories);
    throw new Error(
      `codemanagermcp: unknown repository "${key}".\n` +
      `Known: ${known.length > 0 ? known.join(', ') : '(none configured)'}`,
    );
  }
  return {
    organization: entry.org,
    project:      entry.project,
    repository:   entry.repository,
    apiKeyFile:   config.azureDevOps.apiKeyFile,
  };
}

// ── Utility ───────────────────────────────────────────────────────────────────

// resolved branch name for a feature slug
export function featureBranch(slug: string): string {
  return `${config.branchPrefix}${slug}`;
}

// slugifies a human feature name into a safe branch-name segment
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
