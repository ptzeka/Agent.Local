import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import type { Workspace } from "./workspace.js";

export const deleteFileSchema = z.object({
  path: z
    .string()
    .min(1)
    .describe("Workspace-relative or absolute path to the file or directory to delete."),
  recursive: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Required true to delete a directory and everything inside it. Ignored for files. " +
        "Deleting a directory without recursive:true is refused as a safety guard."
    ),
});

export type DeleteFileInput = z.infer<typeof deleteFileSchema>;

export interface DeleteFileResult {
  path: string;
  deleted: boolean;
  kind: "file" | "directory";
}

export class DeleteFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeleteFileError";
  }
}

export async function deleteFile(
  input: DeleteFileInput,
  workspace: Workspace
): Promise<DeleteFileResult> {
  const absolutePath = workspace.resolveSafe(input.path);

  // deleting the workspace root would wipe the whole sandbox — almost certainly a mistake, not an intent
  if (path.resolve(absolutePath) === path.resolve(workspace.root)) {
    throw new DeleteFileError(
      "Refusing to delete the workspace root. Target a specific file or subdirectory instead."
    );
  }

  // lstat so a link is removed as a link and a missing path fails loudly rather than silently succeeding
  let stats;
  try {
    stats = await fs.lstat(absolutePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new DeleteFileError(
        `No such file or directory: ${workspace.relativize(absolutePath)}`
      );
    }
    throw err;
  }

  if (stats.isDirectory()) {
    if (!input.recursive) {
      throw new DeleteFileError(
        `${workspace.relativize(absolutePath)} is a directory. ` +
          `Pass recursive: true to delete it and all of its contents.`
      );
    }
    await fs.rm(absolutePath, { recursive: true, force: false });
    return { path: workspace.relativize(absolutePath), deleted: true, kind: "directory" };
  }

  await fs.rm(absolutePath, { force: false });
  return { path: workspace.relativize(absolutePath), deleted: true, kind: "file" };
}
