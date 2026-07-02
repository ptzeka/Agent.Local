import { z } from 'zod';
import { resolveCommit, formatResolutionHeader } from './resolution.js';
import { effectiveRepo, pickReader, type ToolDeps } from './registry.js';
import type { EdgeRow } from '../edges/types.js';

export const getRelationshipsSchema = z.object({
  name: z.string().min(1).describe('Symbol name (e.g. wireParser), entity id (path#Class.method), or file path.'),
  type: z.enum(['imports', 'calls', 'implements', 'extends']).optional()
    .describe('Restrict to one edge type.'),
  direction: z.enum(['out', 'in', 'both']).default('both')
    .describe('out = edges leaving the entity (what it calls/imports/implements), in = edges pointing at it (who calls/imports/implements it).'),
  repository: z.string().optional().describe('Repository to query (e.g. owner/repo). Defaults to git origin when it matches a registered name, else the first registration.'),
  commit: z.string().optional().describe('Full commit SHA. Required when several distinct SHAs are indexed for the same repository and branch.'),
});

export type GetRelationshipsInput = z.infer<typeof getRelationshipsSchema>;

export async function getRelationships(input: GetRelationshipsInput, deps: ToolDeps): Promise<string> {
  const { defaultBranch, currentRepository } = deps;
  const repoName = effectiveRepo(input.repository, currentRepository);
  const reader = pickReader(deps, repoName);

  const resolved = await resolveCommit(reader.metadata, {
    branch: defaultBranch,
    repositoryInput: input.repository,
    currentRepository,
    commitOverride: input.commit,
  });
  if (resolved.kind === 'missing') return resolved.message;

  const edges = await reader.edges.listEdges(resolved.commitSha);
  const typed = input.type ? edges.filter(edge => edge.type === input.type) : edges;

  const outgoing = input.direction === 'in' ? [] : typed.filter(edge => matchesEntity(edge.from, input.name));
  const incoming = input.direction === 'out' ? [] : typed.filter(edge => matchesEntity(edge.to, input.name));

  const header = formatResolutionHeader(resolved);
  if (outgoing.length === 0 && incoming.length === 0) {
    return header + `(no relationships for ${input.name})`;
  }
  return header + [
    ...section('outgoing:', outgoing),
    ...section('incoming:', incoming),
  ].join('\n');
}

function section(title: string, edges: EdgeRow[]): string[] {
  if (edges.length === 0) return [];
  return [title, ...edges.map(formatEdge)];
}

function formatEdge(edge: EdgeRow): string {
  return `  ${edge.from} -[${edge.type}]-> ${edge.to}  (line ${edge.line})`;
}

// a query can be a full entity id, a file path, or just the leaf symbol name —
// agents rarely know the exact id, so the leaf match is the common path
function matchesEntity(id: string, query: string): boolean {
  if (id === query) return true;
  const tail = id.includes('#') ? id.slice(id.indexOf('#') + 1) : id;
  if (tail === query) return true;
  const leaf = tail.split('.').pop();
  if (leaf === query) return true;
  return id.replace(/^(external|unresolved):/, '') === query;
}
