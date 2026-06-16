import { z } from 'zod';
import { formatSummaries } from './format.js';
import { resolveCommit, formatResolutionHeader } from './resolution.js';
import { effectiveRepo, pickReader, type ToolDeps } from './registry.js';

export const locateFileSchema = z.object({
  path: z.string().min(1).describe('Repository-relative file path (forward slashes), e.g. src/frontend/src/pages/Weather/WeatherPage.tsx'),
  repository: z.string().optional().describe('Repository to query (e.g. owner/repo). Defaults to git origin when it matches a registered name, else the first registration. REQUIRED when auto-detection failed — the tool refuses the call rather than guess. Resolve from chat context or ask the user.'),
  commit: z.string().optional().describe('Full commit SHA. When several distinct SHAs are indexed for the same repository and branch, this argument is required — use list_commits or ask the user. If only one SHA exists for that pair, it defaults automatically.'),
});

export type LocateFileInput = z.infer<typeof locateFileSchema>;

// exact-match locate tier: a file's chunks as content-free summaries (an outline). Use to see a file's
// shape — symbols and line ranges — before deciding which chunks to expand_chunk or get_file_context.
export async function locateFile(input: LocateFileInput, deps: ToolDeps): Promise<string> {
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

  const summaries = await retrieval.getFileSummaries(resolved.commitSha, input.path);
  if (summaries.length === 0) {
    return formatResolutionHeader(resolved) + `(no chunks for ${input.path} in commit ${resolved.commitSha})`;
  }
  return formatResolutionHeader(resolved) + formatSummaries(summaries);
}
