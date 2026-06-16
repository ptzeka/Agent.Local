import { z } from 'zod';
import { formatChunks } from './format.js';
import { resolveCommit, formatResolutionHeader } from './resolution.js';
import { effectiveRepo, pickReader, type ToolDeps } from './registry.js';
import { chunkRecordId } from '../retrieval/codeRetrieval.js';

export const relatedCodeSchema = z.object({
  path: z.string().min(1).describe('Repository-relative path of the seed chunk (forward slashes), as shown in a [path:start-end] citation.'),
  startLine: z.number().int().min(1).describe('Start line of the seed chunk, as shown in a [path:start-end] citation.'),
  endLine: z.number().int().min(1).describe('End line of the seed chunk, as shown in a [path:start-end] citation.'),
  k: z.number().int().min(1).max(50).optional().default(8).describe('Number of related chunks to return (the seed itself is always excluded).'),
  area: z.string().optional().describe('Restrict to an area: api | backend | frontend | db | test | docs | tools | pipeline | minikube | root'),
  kind: z.string().optional().describe('Restrict to a chunk kind: class | method | function | component | interface | record | section | statement | message | service | rpc | file | window'),
  language: z.string().optional().describe('Restrict to a language: csharp | typescript | tsx | javascript | jsx | markdown | sql | protobuf | json'),
  repository: z.string().optional().describe('Repository to query (e.g. owner/repo). Defaults to git origin when it matches a registered name, else the first registration. REQUIRED when auto-detection failed — the tool refuses the call rather than guess. Resolve from chat context or ask the user.'),
  commit: z.string().optional().describe('Full commit SHA. When several distinct SHAs are indexed for the same repository and branch, this argument is required — use list_commits or ask the user. If only one SHA exists for that pair, it defaults automatically.'),
});

export type RelatedCodeInput = z.infer<typeof relatedCodeSchema>;

// "more like this": ranks the index against the seed chunk's own stored vector, excluding the seed.
// pure semantic similarity — give it a chunk you already have and get its nearest neighbours.
export async function relatedCode(input: RelatedCodeInput, deps: ToolDeps): Promise<string> {
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

  const seedId = chunkRecordId(input.path, input.startLine, input.endLine);
  const chunks = await retrieval.relatedTo(resolved.commitSha, seedId, input.k, {
    area: input.area,
    kind: input.kind,
    language: input.language,
  });
  if (chunks.length === 0) {
    return (
      formatResolutionHeader(resolved) +
      `(no related chunks for ${input.path}:${input.startLine}-${input.endLine} in commit ${resolved.commitSha} — ` +
      `confirm the seed citation is exact, e.g. via get_file_context)`
    );
  }
  return formatResolutionHeader(resolved) + formatChunks(chunks);
}
