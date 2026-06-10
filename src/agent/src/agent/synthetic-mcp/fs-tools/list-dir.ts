import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import type { Workspace } from "./workspace.js";

export const listDirSchema = z.object({
  path: z
    .string()
    .min(1)
    .default(".")
    .describe("Workspace-relative or absolute directory path. Defaults to the workspace root."),
  include_hidden: z
    .boolean()
    .optional()
    .default(false)
    .describe("If true, include entries that start with a dot (e.g. .git, .env)."),
  max_entries: z
    .number()
    .int()
    .positive()
    .optional()
    .default(500)
    .describe("Cap on the number of entries returned. Defaults to 500."),
});

export type ListDirInput = z.infer<typeof listDirSchema>;

export interface DirEntry {
  name: string;
  type: "file" | "directory" | "symlink" | "other";
  size_bytes?: number;
}

export interface ListDirResult {
  path: string;
  total_entries: number;
  truncated: boolean;
  entries: DirEntry[];
}

export async function listDir(
  input: ListDirInput,
  workspace: Workspace
): Promise<ListDirResult> {
  const absolutePath = workspace.resolveSafe(input.path);
  const raw = await fs.readdir(absolutePath, { withFileTypes: true });

  const filtered = input.include_hidden
    ? raw
    : raw.filter((entry) => !entry.name.startsWith("."));

  // Sort directories first, then files, then alphabetically — easier for the model to scan.
  filtered.sort((a, b) => {
    const aIsDir = a.isDirectory();
    const bIsDir = b.isDirectory();
    if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const limit = input.max_entries ?? 500;
  const truncated = filtered.length > limit;
  const visibleEntries = filtered.slice(0, limit);

  const entries: DirEntry[] = await Promise.all(
    visibleEntries.map(async (entry) => {
      const entryPath = path.join(absolutePath, entry.name);
      const type = classifyEntry(entry);

      // Only stat files — directory sizes aren't meaningful here and we'd pay extra IO.
      let sizeBytes: number | undefined;
      if (type === "file") {
        try {
          const stat = await fs.stat(entryPath);
          sizeBytes = stat.size;
        } catch {
          sizeBytes = undefined;
        }
      }

      return { name: entry.name, type, size_bytes: sizeBytes };
    })
  );

  return {
    path: workspace.relativize(absolutePath),
    total_entries: filtered.length,
    truncated,
    entries,
  };
}

function classifyEntry(entry: import("node:fs").Dirent): DirEntry["type"] {
  if (entry.isDirectory()) return "directory";
  if (entry.isFile()) return "file";
  if (entry.isSymbolicLink()) return "symlink";
  return "other";
}
