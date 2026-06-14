import fs from "node:fs/promises";
import { z } from "zod";

import type { Workspace } from "./workspace.js";

export const editFileSchema = z.object({
  path: z
    .string()
    .min(1)
    .describe("Workspace-relative or absolute path to the file to edit."),
  old_string: z
    .string()
    .min(1)
    .describe(
      "Exact text to replace. Must match the file's current content byte-for-byte and " +
        "must be unique within the file unless replace_all is true."
    ),
  new_string: z
    .string()
    .describe("Replacement text. May be empty to delete the matched region."),
  replace_all: z
    .boolean()
    .optional()
    .default(false)
    .describe("If true, replace every occurrence of old_string instead of requiring uniqueness."),
});

export type EditFileInput = z.infer<typeof editFileSchema>;

export interface EditFileResult {
  path: string;
  replacements: number;
}

export class EditFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EditFileError";
  }
}

export async function editFile(
  input: EditFileInput,
  workspace: Workspace
): Promise<EditFileResult> {
  const absolutePath = workspace.resolveSafe(input.path);
  const original = await fs.readFile(absolutePath, "utf8");

  // fail loudly on a missing target so the model re-reads and adjusts instead of editing blind
  if (!original.includes(input.old_string)) {
    throw new EditFileError(
      `old_string was not found in ${workspace.relativize(absolutePath)}. ` +
        `Read the file first and copy the text exactly, including whitespace.`
    );
  }

  let updated: string;
  let replacements: number;

  if (input.replace_all) {
    const parts = original.split(input.old_string);
    replacements = parts.length - 1;
    updated = parts.join(input.new_string);
  } else {
    const occurrences = countOccurrences(original, input.old_string);

    if (occurrences > 1) {
      throw new EditFileError(
        `old_string appears ${occurrences} times in ${workspace.relativize(
          absolutePath
        )}. Provide more surrounding context to make it unique, or set replace_all: true.`
      );
    }

    updated = original.replace(input.old_string, input.new_string);
    replacements = 1;
  }

  await fs.writeFile(absolutePath, updated, "utf8");

  return {
    path: workspace.relativize(absolutePath),
    replacements,
  };
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = 0;
  while ((index = haystack.indexOf(needle, index)) !== -1) {
    count += 1;
    index += needle.length;
  }
  return count;
}
