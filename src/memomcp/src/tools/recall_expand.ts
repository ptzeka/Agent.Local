import { z } from 'zod';
import type { ToolDeps } from './registry.js';
import { resolveCollection } from './registry.js';
import { formatExpanded } from './format.js';

export const recallExpandSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).describe('vectorId values (as shown by recall_locate) of the memories to expand to full content.'),
  collection: z.string().optional().describe('Collection id the ids belong to. Defaults to the server collection.'),
});

export type RecallExpandInput = z.infer<typeof recallExpandSchema>;

// expand tier of two-tier recall: the full memory bodies behind the vectorIds a recall_locate surfaced.
// unknown ids are skipped, so an empty result means none of the ids resolved in this collection.
export async function recallExpand(input: RecallExpandInput, deps: ToolDeps): Promise<string> {
  const collection = resolveCollection(input.collection, deps);
  const memories = await deps.repository.expand(collection, input.ids);
  return formatExpanded(memories);
}
