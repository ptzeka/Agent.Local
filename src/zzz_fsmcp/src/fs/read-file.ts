import fs from "node:fs/promises";
import { z } from "zod";

import type { Workspace } from "../workspace.js";

export const readFileSchema = z.object({
  path: z
    .string()
    .min(1)
    .describe("Workspace-relative or absolute path to the file to read."),
  start_line: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("1-indexed first line to return. Omit to start at line 1."),
  end_line: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("1-indexed last line to return (inclusive). Omit to read to EOF."),
});

export type ReadFileInput = z.infer<typeof readFileSchema>;

export interface ReadFileResult {
  path: string;
  total_lines: number;
  returned_range: { start: number; end: number };
  content: string;
}

export async function readFile(
  input: ReadFileInput,
  workspace: Workspace
): Promise<ReadFileResult> {
  const absolutePath = workspace.resolveSafe(input.path);
  const raw = await fs.readFile(absolutePath, "utf8");

  const lines = raw.split(/\r?\n/);
  const totalLines = lines.length;

  const startLine = input.start_line ?? 1;
  const endLine = Math.min(input.end_line ?? totalLines, totalLines);

  if (startLine > totalLines) {
    return {
      path: workspace.relativize(absolutePath),
      total_lines: totalLines,
      returned_range: { start: startLine, end: startLine - 1 },
      content: "",
    };
  }

  const slice = lines.slice(startLine - 1, endLine).join("\n");

  return {
    path: workspace.relativize(absolutePath),
    total_lines: totalLines,
    returned_range: { start: startLine, end: endLine },
    content: slice,
  };
}
