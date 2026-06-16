import { z } from 'zod';
import type { ToolDeps } from './registry.js';
import { resolveCollection } from './registry.js';
import { formatLocate } from './format.js';

export const recallLocateSchema = z.object({
  query: z.string().min(1).describe('Natural-language query to rank archival memories against.'),
  collection: z.string().optional().describe('Collection id to recall from. Defaults to the server collection.'),
  k: z.number().int().min(1).max(50).optional().default(8).describe('How many archival memories to rank back. Core memories are always returned.'),
  category: z.string().optional().describe('Restrict to memories with this category.'),
  tenant: z.string().optional().describe('Restrict to memories with this tenant.'),
});

export type RecallLocateInput = z.infer<typeof recallLocateSchema>;

// locate tier of two-tier recall: content-free summaries (no memory body) so an agent can scan what
// exists, then pull the bodies it wants with recall_expand using the vectorIds shown here.
export async function recallLocate(input: RecallLocateInput, deps: ToolDeps): Promise<string> {
  const collection = resolveCollection(input.collection, deps);
  const result = await deps.repository.locate(collection, {
    query: input.query,
    k: input.k,
    category: input.category,
    tenant: input.tenant,
  });
  return formatLocate(result);
}
