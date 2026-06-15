import { z } from 'zod';
import { formatChunks } from './format.js';
import { resolveCommit, formatResolutionHeader } from './resolution.js';
import { effectiveRepo, pickReader, type ToolDeps } from './registry.js';

export const getFileContextSchema = z.object({
  path: z.string().min(1).describe('Repository-relative file path (forward slashes), e.g. src/frontend/src/pages/Weather/WeatherPage.tsx'),
  repository: z.string().optional().describe('Repository to query (e.g. owner/repo). Defaults to git origin when it matches a registered name, else the first registration. REQUIRED when auto-detection failed — the tool refuses the call rather than guess. Resolve from chat context or ask the user.'),
  commit: z.string().optional().describe('Full commit SHA. When several distinct SHAs are indexed for the same repository and branch, this argument is required — use list_commits or ask the user. If only one SHA exists for that pair, it defaults automatically.'),
});

export type GetFileContextInput = z.infer<typeof getFileContextSchema>;

export async function getFileContext(input: GetFileContextInput, deps: ToolDeps): Promise<string> {
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

  const chunks = await retrieval.getFileChunks(resolved.commitSha, input.path);
  if (chunks.length === 0) {
    return formatResolutionHeader(resolved) + `(no chunks for ${input.path} in commit ${resolved.commitSha})`;
  }
  const claudeMd = chunks[0]?.claudeMd ?? [];
  const governance = claudeMd.length > 0
    ? `Governing CLAUDE.md files for this path:\n  ${claudeMd.join('\n  ')}\n\n`
    : '';
  return formatResolutionHeader(resolved) + governance + formatChunks(chunks);
}
