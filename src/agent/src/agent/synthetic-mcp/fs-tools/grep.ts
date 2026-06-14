import fs from "node:fs/promises";
import fastGlob from "fast-glob";
import { z } from "zod";

import type { Workspace } from "./workspace.js";

export const grepSchema = z.object({
  pattern: z
    .string()
    .min(1)
    .describe("JavaScript-compatible regular expression to search for."),
  path_glob: z
    .string()
    .optional()
    .default("**/*")
    .describe('Glob limiting which files are scanned, e.g. "src/**/*.ts". Defaults to "**/*".'),
  case_insensitive: z
    .boolean()
    .optional()
    .default(false)
    .describe("If true, match without case sensitivity."),
  max_results: z
    .number()
    .int()
    .positive()
    .optional()
    .default(200)
    .describe("Cap on the number of matching lines returned across all files."),
});

export type GrepInput = z.infer<typeof grepSchema>;

export interface GrepMatch {
  path: string;
  line_number: number;
  line: string;
}

export interface GrepResult {
  pattern: string;
  path_glob: string;
  matches: GrepMatch[];
  truncated: boolean;
  files_scanned: number;
}

// a null byte in the first 4 KB marks a file binary and skips it: misses obscure formats but is fast and safe
const BINARY_PROBE_BYTES = 4096;

export async function grep(input: GrepInput, workspace: Workspace): Promise<GrepResult> {
  const root = workspace.root;
  const limit = input.max_results ?? 200;

  const flags = input.case_insensitive ? "i" : "";
  let regex: RegExp;
  try {
    regex = new RegExp(input.pattern, flags);
  } catch (err) {
    throw new Error(
      `Invalid regular expression "${input.pattern}": ${(err as Error).message}`
    );
  }

  const candidatePaths = await fastGlob(input.path_glob ?? "**/*", {
    cwd: root,
    dot: false,
    onlyFiles: true,
    followSymbolicLinks: false,
    absolute: true,
    suppressErrors: true,
    ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**"],
  });

  const matches: GrepMatch[] = [];
  let filesScanned = 0;
  let truncated = false;

  for (const absolutePath of candidatePaths) {
    let safeAbsolute: string;
    try {
      safeAbsolute = workspace.resolveSafe(absolutePath);
    } catch {
      continue;
    }

    if (await looksBinary(safeAbsolute)) continue;

    let content: string;
    try {
      content = await fs.readFile(safeAbsolute, "utf8");
    } catch {
      continue;
    }
    filesScanned += 1;

    const relativePath = workspace.relativize(safeAbsolute);
    const lines = content.split(/\r?\n/);

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (regex.test(line)) {
        matches.push({ path: relativePath, line_number: i + 1, line });
        if (matches.length >= limit) {
          truncated = true;
          break;
        }
      }
    }

    if (truncated) break;
  }

  return {
    pattern: input.pattern,
    path_glob: input.path_glob ?? "**/*",
    matches,
    truncated,
    files_scanned: filesScanned,
  };
}

async function looksBinary(absolutePath: string): Promise<boolean> {
  try {
    const handle = await fs.open(absolutePath, "r");
    try {
      const buffer = Buffer.alloc(BINARY_PROBE_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, BINARY_PROBE_BYTES, 0);
      for (let i = 0; i < bytesRead; i += 1) {
        if (buffer[i] === 0) return true;
      }
      return false;
    } finally {
      await handle.close();
    }
  } catch {
    return true;
  }
}
