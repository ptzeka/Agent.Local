import fastGlob from "fast-glob";
import { z } from "zod";

import type { Workspace } from "../workspace.js";

export const globSchema = z.object({
  pattern: z
    .string()
    .min(1)
    .describe('Glob pattern, e.g. "**/*.ts" or "src/**/handlers/*.js".'),
  cwd: z
    .string()
    .optional()
    .default(".")
    .describe("Workspace-relative directory to search from. Defaults to the workspace root."),
  include_hidden: z
    .boolean()
    .optional()
    .default(false)
    .describe("If true, include dotfiles in the match set."),
  max_results: z
    .number()
    .int()
    .positive()
    .optional()
    .default(500)
    .describe("Cap on the number of paths returned. Defaults to 500."),
});

export type GlobInput = z.infer<typeof globSchema>;

export interface GlobResult {
  pattern: string;
  cwd: string;
  matches: string[];
  truncated: boolean;
}

export async function glob(input: GlobInput, workspace: Workspace): Promise<GlobResult> {
  const cwdAbsolute = workspace.resolveSafe(input.cwd ?? ".");
  const limit = input.max_results ?? 500;

  // re-relativized to the workspace below so the model always sees one coordinate system
  const rawMatches = await fastGlob(input.pattern, {
    cwd: cwdAbsolute,
    dot: input.include_hidden,
    onlyFiles: false,
    followSymbolicLinks: false,
    absolute: true,
    suppressErrors: true,
  });

  const matches: string[] = [];
  for (const absolute of rawMatches) {
    // defence in depth against symlinks and "../" patterns fast-glob might follow out of the workspace
    try {
      const safeAbsolute = workspace.resolveSafe(absolute);
      matches.push(workspace.relativize(safeAbsolute));
    } catch {
      continue;
    }

    if (matches.length >= limit) break;
  }

  return {
    pattern: input.pattern,
    cwd: workspace.relativize(cwdAbsolute),
    matches,
    truncated: rawMatches.length > matches.length,
  };
}
