import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import type { Workspace } from "../workspace.js";

export const writeFileSchema = z.object({
  path: z
    .string()
    .min(1)
    .describe("Workspace-relative or absolute path to the file to create or overwrite."),
  content: z
    .string()
    .describe("Full file content. The file is written verbatim, no extra newline appended."),
  create_directories: z
    .boolean()
    .optional()
    .default(true)
    .describe("If true (default), create any missing parent directories."),
});

export type WriteFileInput = z.infer<typeof writeFileSchema>;

export interface WriteFileResult {
  path: string;
  bytes_written: number;
  created: boolean;
}

export async function writeFile(
  input: WriteFileInput,
  workspace: Workspace
): Promise<WriteFileResult> {
  const absolutePath = workspace.resolveSafe(input.path);

  // Track whether the file existed beforehand so we can report create vs overwrite.
  const existedBefore = await fileExists(absolutePath);

  if (input.create_directories !== false) {
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  }

  await fs.writeFile(absolutePath, input.content, "utf8");

  const stat = await fs.stat(absolutePath);

  return {
    path: workspace.relativize(absolutePath),
    bytes_written: stat.size,
    created: !existedBefore,
  };
}

async function fileExists(absolutePath: string): Promise<boolean> {
  try {
    await fs.access(absolutePath);
    return true;
  } catch {
    return false;
  }
}
