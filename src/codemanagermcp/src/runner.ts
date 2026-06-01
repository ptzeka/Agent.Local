import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RunOptions {
  /** Working directory for the command. */
  cwd?: string;
  /** Timeout in milliseconds. Default: 120 000 ms. */
  timeoutMs?: number;
  /** Extra environment variables merged over process.env. */
  env?: NodeJS.ProcessEnv;
}

/** Runs a shell command. Never throws — returns exit code + captured output. */
export async function run(command: string, options: RunOptions = {}): Promise<RunResult> {
  const { cwd, timeoutMs = 120_000, env } = options;
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout: timeoutMs,
      env: { ...process.env, ...env },
      maxBuffer: 10 * 1024 * 1024,
    });
    return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number | null };
    return {
      stdout: (e.stdout ?? '').trim(),
      stderr: (e.stderr ?? '').trim(),
      exitCode: typeof e.code === 'number' ? e.code : 1,
    };
  }
}

/** Runs a shell command and throws if it exits non-zero. */
export async function mustRun(command: string, options: RunOptions = {}): Promise<RunResult> {
  const result = await run(command, options);
  if (result.exitCode !== 0) {
    const lines: string[] = [`Command failed (exit ${result.exitCode}): ${command}`];
    if (result.stderr) lines.push(`stderr: ${result.stderr}`);
    if (result.stdout) lines.push(`stdout: ${result.stdout}`);
    throw new Error(lines.join('\n'));
  }
  return result;
}

/** Formats a RunResult as a human-readable block for MCP output. */
export function formatResult(label: string, result: RunResult): string {
  const lines: string[] = [`${label} (exit ${result.exitCode})`];
  if (result.stdout) lines.push(result.stdout);
  if (result.stderr) lines.push(`[stderr] ${result.stderr}`);
  return lines.join('\n');
}
