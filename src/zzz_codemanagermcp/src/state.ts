import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

export interface WorkflowState {
  featureName: string;
  branchName: string;
  // exposed as the BRANCH_SLUG pipeline variable
  branchSlug: string;
  envDeployed: boolean;
  // kept for status polling of the latest deploy run
  lastDeployRunId?: number;
  // kept for status polling of the latest CI run
  lastCiRunId?: number;
  // set after accept_changes creates or finds the PR
  prId?: number;
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

// null when no state exists or the file is empty/corrupt
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

export function writeState(dataDirPath: string, state: WorkflowState): void {
  ensureDir(dataDirPath);
  writeFileSync(statePath(dataDirPath), JSON.stringify(state, null, 2), 'utf-8');
}

// throws when no feature is active, since a patch with no base would silently create a partial state
export function patchState(dataDirPath: string, patch: Partial<WorkflowState>): WorkflowState {
  const current = readState(dataDirPath);
  if (!current) throw new Error('codemanagermcp: no active feature — call start_feature first.');
  const next: WorkflowState = { ...current, ...patch };
  writeState(dataDirPath, next);
  return next;
}

// removing the file is what signals "no active feature"
export function clearState(dataDirPath: string): void {
  const path = statePath(dataDirPath);
  if (existsSync(path)) rmSync(path);
}

export function dataDir(configDir: string): string {
  return resolve(configDir, 'data');
}
