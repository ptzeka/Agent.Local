import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

export interface WorkflowState {
  /** Human-readable feature name as passed to start_feature. */
  featureName: string;
  /** Full branch name (branchPrefix + slugified featureName). */
  branchName: string;
  /** Slugified feature name (used as BRANCH_SLUG pipeline variable). */
  branchSlug: string;
  /** Whether the ephemeral environment has been deployed at least once. */
  envDeployed: boolean;
  /** ADO run ID of the most recent deploy pipeline run, for status polling. */
  lastDeployRunId?: number;
  /** ADO run ID of the most recent CI pipeline run, for status polling. */
  lastCiRunId?: number;
  /** Azure DevOps PR ID, set after accept_changes creates or finds the PR. */
  prId?: number;
  /** Azure DevOps PR web URL. */
  prUrl?: string;
}

function statePath(dataDirPath: string): string {
  return resolve(dataDirPath, 'state.json');
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/** Reads the current workflow state, or null if none exists. */
export function readState(dataDirPath: string): WorkflowState | null {
  const path = statePath(dataDirPath);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf-8').trim();
    if (!raw || raw === '{}') return null;
    return JSON.parse(raw) as WorkflowState;
  } catch {
    return null;
  }
}

/** Persists workflow state to disk. */
export function writeState(dataDirPath: string, state: WorkflowState): void {
  ensureDir(dataDirPath);
  writeFileSync(statePath(dataDirPath), JSON.stringify(state, null, 2), 'utf-8');
}

/** Merges a partial update into the current state and persists it. */
export function patchState(dataDirPath: string, patch: Partial<WorkflowState>): WorkflowState {
  const current = readState(dataDirPath);
  if (!current) throw new Error('codemanagermcp: no active feature — call start_feature first.');
  const next: WorkflowState = { ...current, ...patch };
  writeState(dataDirPath, next);
  return next;
}

/** Removes the state file, signalling no active feature. */
export function clearState(dataDirPath: string): void {
  const path = statePath(dataDirPath);
  if (existsSync(path)) rmSync(path);
}

/** Returns the data directory path used by this config directory. */
export function dataDir(configDir: string): string {
  return resolve(configDir, 'data');
}
