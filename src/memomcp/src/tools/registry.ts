import { z } from 'zod';
import type { MemoryRepository } from '../memory/memoryRepository.js';
import { remember, rememberSchema } from './remember.js';
import { recall, recallSchema } from './recall.js';
import { recallLocate, recallLocateSchema } from './recall_locate.js';
import { recallExpand, recallExpandSchema } from './recall_expand.js';

export interface ToolDeps {
  repository: MemoryRepository;
  // collection used when a call omits `collection`
  defaultCollection: string;
}

// effective collection from explicit input then the server default; a memory collection is opaque,
// so a configured default is enough — no "refuse to guess" as codemcp needs for repositories
export function resolveCollection(input: string | undefined, deps: ToolDeps): string {
  const explicit = input?.trim();
  if (explicit && explicit.length > 0) return explicit;
  return deps.defaultCollection;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  zodSchema: z.ZodTypeAny;
  handler: (input: unknown, deps: ToolDeps) => Promise<string>;
}

export const TOOLS: ToolDef[] = [
  {
    name: 'remember',
    description: 'Store a memory in a collection. `kind` controls recall salience: "core" memories are always returned, "archival" memories are retrieved top-k by similarity. category/tenant are scalar dimensions a later recall can filter on; tags are stored free-form. Pass `id` to overwrite an existing memory.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The memory text to store.' },
        collection: { type: 'string', description: 'Collection id (opaque partition: user/session/topic). Defaults to the server collection.' },
        kind: { type: 'string', enum: ['core', 'archival'], default: 'archival', description: 'core = always recalled; archival = top-k by similarity.' },
        category: { type: 'string', description: 'Category label; a recall filter dimension.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Free-form tags (stored, not filtered).' },
        tenant: { type: 'string', description: 'Tenant/owner label; a recall filter dimension.' },
        source: { type: 'string', description: 'Provenance (conversation id, document path, ...).' },
        id: { type: 'string', description: 'Provide to overwrite an existing memory (upsert-by-id).' },
      },
      required: ['content'],
    },
    zodSchema: rememberSchema,
    handler: (input, deps) => remember(rememberSchema.parse(input), deps),
  },
  {
    name: 'recall',
    description: 'Retrieve memories from a collection: all "core" memories plus the top-k "archival" memories ranked by similarity to `query`. Optionally narrow by category/tenant. Output lists core memories first, then archival ranked by score (cosine distance, lower is closer).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language query to rank archival memories against.' },
        collection: { type: 'string', description: 'Collection id to recall from. Defaults to the server collection.' },
        k: { type: 'integer', minimum: 1, maximum: 50, default: 8, description: 'How many archival memories to rank back.' },
        category: { type: 'string', description: 'Restrict to memories with this category.' },
        tenant: { type: 'string', description: 'Restrict to memories with this tenant.' },
      },
      required: ['query'],
    },
    zodSchema: recallSchema,
    handler: (input, deps) => recall(recallSchema.parse(input), deps),
  },
  {
    name: 'recall_locate',
    description: 'Locate tier of two-tier recall: like `recall`, but returns content-free summaries (no memory body) so you can scan what exists cheaply before reading anything. Lists all "core" memories plus the top-k "archival" matches as `(memoryId) vectorId=… [metadata · score]` lines. Feed the vectorId values into `recall_expand` to read the bodies you actually want.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language query to rank archival memories against.' },
        collection: { type: 'string', description: 'Collection id to recall from. Defaults to the server collection.' },
        k: { type: 'integer', minimum: 1, maximum: 50, default: 8, description: 'How many archival memories to rank back.' },
        category: { type: 'string', description: 'Restrict to memories with this category.' },
        tenant: { type: 'string', description: 'Restrict to memories with this tenant.' },
      },
      required: ['query'],
    },
    zodSchema: recallLocateSchema,
    handler: (input, deps) => recallLocate(recallLocateSchema.parse(input), deps),
  },
  {
    name: 'recall_expand',
    description: 'Expand tier of two-tier recall: returns the full content of specific memories by their `vectorId` (as shown by `recall_locate`). Pass one or more ids; unknown ids are skipped. Use this after `recall_locate` to read only the memories you chose, without pulling every body up front.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' }, description: 'vectorId values (from recall_locate) of the memories to expand.' },
        collection: { type: 'string', description: 'Collection id the ids belong to. Defaults to the server collection.' },
      },
      required: ['ids'],
    },
    zodSchema: recallExpandSchema,
    handler: (input, deps) => recallExpand(recallExpandSchema.parse(input), deps),
  },
];

export function findTool(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.name === name);
}
