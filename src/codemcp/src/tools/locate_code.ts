import { z } from 'zod';
import { formatSummaries } from './format.js';
import { resolveCommit, formatResolutionHeader } from './resolution.js';
import { effectiveRepo, pickReader, type ToolDeps } from './registry.js';

export const locateCodeSchema = z.object({
  query: z.string().min(1).describe('Natural-language or code-fragment query to locate by meaning.'),
  k: z.number().int().min(1).max(50).optional().default(12).describe('Number of summaries to return.'),
  area: z.string().optional().describe('Restrict to an area: api | backend | frontend | db | test | docs | tools | pipeline | minikube | root'),
  kind: z.string().optional().describe('Restrict to a chunk kind: class | method | function | component | interface | record | section | statement | message | service | rpc | file | window'),
  language: z.string().optional().describe('Restrict to a language: csharp | typescript | tsx | javascript | jsx | markdown | sql | protobuf | json'),
  repository: z.string().optional().describe('Repository to query (e.g. owner/repo). Defaults to git origin when it matches a registered name, else the first registration. REQUIRED when auto-detection failed — the tool refuses the call rather than guess. Resolve from chat context or ask the user.'),
  commit: z.string().optional().describe('Full commit SHA. When several distinct SHAs are indexed for the same repository and branch, this argument is required — use list_commits or ask the user. If only one SHA exists for that pair, it defaults automatically.'),
});

export type LocateCodeInput = z.infer<typeof locateCodeSchema>;

// the cheap locate tier of two-tier retrieval: same ranking as search_code but returns content-free
// summaries (citation + symbol + score). Pick the [path:start-end] hits you want, then expand_chunk them.
export async function locateCode(input: LocateCodeInput, deps: ToolDeps): Promise<string> {
  const { embedder, defaultBranch, currentRepository } = deps;
  const repoName = effectiveRepo(input.repository, currentRepository);
  const { retrieval, metadata } = pickReader(deps, repoName);

  const resolved = await resolveCommit(metadata, {
    branch: defaultBranch,
    repositoryInput: input.repository,
    currentRepository,
    commitOverride: input.commit,
  });
  if (resolved.kind === 'missing') return resolved.message;

  const vector = await embedder.embedQuery(input.query);
  if (vector.length !== embedder.dim) {
    throw new Error(`Query embedding has dim ${vector.length}, expected ${embedder.dim}`);
  }

  const summaries = await retrieval.locate(resolved.commitSha, vector, input.k, {
    area: input.area,
    kind: input.kind,
    language: input.language,
  });
  return formatResolutionHeader(resolved) + formatSummaries(summaries);
}
