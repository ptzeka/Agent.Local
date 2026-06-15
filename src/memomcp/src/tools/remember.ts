import { z } from 'zod';
import type { ToolDeps } from './registry.js';
import { resolveCollection } from './registry.js';

export const rememberSchema = z.object({
  content: z.string().min(1).describe('The memory text to store.'),
  collection: z.string().optional().describe('Collection id to store under (an opaque partition: a user, session, or topic). Defaults to the server collection.'),
  kind: z.enum(['core', 'archival']).optional().default('archival').describe('core = small/high-salience, always returned on recall; archival = the bulk, retrieved top-k by similarity.'),
  category: z.string().optional().describe('Category label; a scalar dimension recall can filter on.'),
  tags: z.array(z.string()).optional().describe('Free-form tags stored with the memory (not used as a recall filter).'),
  tenant: z.string().optional().describe('Tenant/owner label; a scalar dimension recall can filter on.'),
  source: z.string().optional().describe('Where the memory came from (e.g. a conversation id or document path).'),
  id: z.string().optional().describe('Provide to overwrite an existing memory (upsert-by-id); omit to mint a fresh id.'),
});

export type RememberInput = z.infer<typeof rememberSchema>;

export async function remember(input: RememberInput, deps: ToolDeps): Promise<string> {
  const collection = resolveCollection(input.collection, deps);
  const id = await deps.repository.remember(collection, {
    content: input.content,
    kind: input.kind,
    category: input.category,
    tags: input.tags,
    tenant: input.tenant,
    source: input.source,
    id: input.id,
  });
  return `remembered ${input.kind} memory ${id} in collection "${collection}"`;
}
