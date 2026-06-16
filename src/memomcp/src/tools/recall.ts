import { z } from 'zod';
import type { ToolDeps } from './registry.js';
import { resolveCollection } from './registry.js';
import { formatRecall } from './format.js';

export const recallSchema = z.object({
  query: z.string().min(1).describe('Natural-language query to rank archival memories against.'),
  collection: z.string().optional().describe('Collection id to recall from. Defaults to the server collection.'),
  k: z.number().int().min(1).max(50).optional().default(8).describe('How many archival memories to rank back. Core memories are always returned in full.'),
  category: z.string().optional().describe('Restrict to memories with this category.'),
  tenant: z.string().optional().describe('Restrict to memories with this tenant.'),
  rank: z.boolean().optional().default(false).describe('Re-rank the archival matches by a reranker relevance score before returning the top k, instead of pure cosine order.'),
});

export type RecallInput = z.infer<typeof recallSchema>;

export async function recall(input: RecallInput, deps: ToolDeps): Promise<string> {
  const collection = resolveCollection(input.collection, deps);
  const result = await deps.repository.recall(collection, {
    query: input.query,
    k: input.k,
    category: input.category,
    tenant: input.tenant,
    rank: input.rank,
  });
  return formatRecall(result);
}
