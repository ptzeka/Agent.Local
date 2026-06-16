import { z } from 'zod';
import { formatSummaries } from './format.js';
import { resolveCommit, formatResolutionHeader } from './resolution.js';
import { effectiveRepo, pickReader, type ToolDeps } from './registry.js';

export const locateSymbolSchema = z.object({
  name: z.string().min(1).describe('Exact symbol name to look up (class, function, component, message, etc.).'),
  repository: z.string().optional().describe('Repository to query (e.g. owner/repo). Defaults to git origin when it matches a registered name, else the first registration. REQUIRED when auto-detection failed — the tool refuses the call rather than guess. Resolve from chat context or ask the user.'),
  commit: z.string().optional().describe('Full commit SHA. When several distinct SHAs are indexed for the same repository and branch, this argument is required — use list_commits or ask the user. If only one SHA exists for that pair, it defaults automatically.'),
});

export type LocateSymbolInput = z.infer<typeof locateSymbolSchema>;

// exact-match locate tier: every definition of a symbol as content-free summaries. Use when you only
// need to see where a symbol lives (and pick which to expand_chunk) rather than read all of it.
export async function locateSymbol(input: LocateSymbolInput, deps: ToolDeps): Promise<string> {
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

  const summaries = await retrieval.findSymbolSummaries(resolved.commitSha, input.name);
  return formatResolutionHeader(resolved) + formatSummaries(summaries);
}
