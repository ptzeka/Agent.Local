import { z } from 'zod';
import { formatChunk } from './format.js';
import { resolveCommit, formatResolutionHeader } from './resolution.js';
import { effectiveRepo, pickReader, type ToolDeps } from './registry.js';
import { chunkRecordId } from '../retrieval/codeRetrieval.js';

export const expandChunkSchema = z.object({
  path: z.string().min(1).describe('Repository-relative path of the chunk (forward slashes), as shown in a [path:start-end] citation.'),
  startLine: z.number().int().min(1).describe('Start line of the chunk, as shown in a [path:start-end] citation.'),
  endLine: z.number().int().min(1).describe('End line of the chunk, as shown in a [path:start-end] citation.'),
  repository: z.string().optional().describe('Repository to query (e.g. owner/repo). Defaults to git origin when it matches a registered name, else the first registration. REQUIRED when auto-detection failed — the tool refuses the call rather than guess. Resolve from chat context or ask the user.'),
  commit: z.string().optional().describe('Full commit SHA. When several distinct SHAs are indexed for the same repository and branch, this argument is required — use list_commits or ask the user. If only one SHA exists for that pair, it defaults automatically.'),
});

export type ExpandChunkInput = z.infer<typeof expandChunkSchema>;

// the expand tier of two-tier retrieval: fetch the full content behind one [path:start-end] citation
// that locate_code / locate_symbol / locate_file surfaced.
export async function expandChunk(input: ExpandChunkInput, deps: ToolDeps): Promise<string> {
  const { defaultBranch, currentRepository } = deps;
  const repoName = effectiveRepo(input.repository, currentRepository);
  const { retrieval, metadata } = pickReader(deps, repoName);

  const resolved = await resolveCommit(metadata, {
    branch: defaultBranch,
    repositoryInput: input.repository,
    currentRepository,
    commitOverride: input.commit,
  });
  if (resolved.kind === 'missing') return resolved.message;

  const chunkId = chunkRecordId(input.path, input.startLine, input.endLine);
  const chunk = await retrieval.getChunk(resolved.commitSha, chunkId);
  if (chunk === null) {
    return (
      formatResolutionHeader(resolved) +
      `(no chunk at ${input.path}:${input.startLine}-${input.endLine} in commit ${resolved.commitSha} — ` +
      `the line range must match a citation exactly; use locate_file to see the file's chunk boundaries)`
    );
  }
  return formatResolutionHeader(resolved) + formatChunk(chunk);
}
