import { randomUUID } from 'node:crypto';
import type { IVectorStore, MetadataFilter, RetrievedRecord, VectorRecord } from '@agent-local/vectorstore';
import type { IVectorService } from '@agent-local/vectorizer';
import type {
  MemoryInput,
  MemoryMetadata,
  RecallFilter,
  RecallQuery,
  RecallResult,
  RecalledMemory,
} from './types.js';

// folds the generic vector store into memory operations: a collection id is the store namespace,
// memory metadata conventions (kind/category/tenant/...) are the only thing this layer adds.
// the store never learns "memory" — same boundary that keeps it from learning "commit".
export class MemoryRepository {
  constructor(
    private readonly store: IVectorStore,
    private readonly embedder: IVectorService,
  ) {}

  // append (or overwrite by memory id) one memory into a collection; returns the memory's own id
  async remember(collection: string, input: MemoryInput): Promise<string> {
    const content = input.content.trim();
    if (content.length === 0) {
      throw new Error('Cannot remember empty content.');
    }
    const memoryId = input.id?.trim() || randomUUID();
    // document input_type for voyage, so paraphrase recall ranks against query-typed embeddings
    const [embedding] = await this.embedder.embedBatch([content]);
    if (!embedding) {
      throw new Error('Embedder returned no vector for the memory content.');
    }
    this.assertDim(embedding.length);

    // a memory maps 1:1 to one vector record; reuse the vector id on overwrite so the record
    // identity stays stable across re-embeds, mint a fresh one only for a memory we have not seen
    const vectorId = await this.resolveVectorId(collection, memoryId);
    const metadata = buildMetadata(memoryId, input);
    const record: VectorRecord = {
      id: vectorId,
      namespace: collection,
      content,
      embedding,
      metadata: metadata as unknown as Record<string, unknown>,
    };
    await this.store.upsert([record]);
    return memoryId;
  }

  // recall = the collection's core records (always, by equality filter) plus top-k archival by similarity
  async recall(collection: string, query: RecallQuery): Promise<RecallResult> {
    const base = buildFilter(query);

    const coreRecords = await this.store.list(collection, { ...base, kind: 'core' });

    const vector = await this.embedder.embedQuery(query.query);
    this.assertDim(vector.length);
    const archivalHits = await this.store.searchByEmbedding(collection, vector, query.k, {
      ...base,
      kind: 'archival',
    });

    return {
      collection,
      core: coreRecords.map((r) => toRecalled(r)),
      archival: archivalHits.map((h) => toRecalled(h.record, h.score)),
    };
  }

  // the existing vector id for this memory, or a fresh one — keeps memory 1:1 with its vector record
  private async resolveVectorId(collection: string, memoryId: string): Promise<string> {
    const [existing] = await this.store.list(collection, { memoryId });
    return existing?.id ?? randomUUID();
  }

  private assertDim(actual: number): void {
    if (actual !== this.embedder.dim) {
      throw new Error(`Embedding has dim ${actual}, expected ${this.embedder.dim} for ${this.embedder.modelId}.`);
    }
  }
}

// drops undefined fields so the stored metadata stays minimal and equality filters compare cleanly
function buildMetadata(memoryId: string, input: MemoryInput): MemoryMetadata {
  const metadata: MemoryMetadata = {
    memoryId,
    kind: input.kind ?? 'archival',
    createdAt: new Date().toISOString(),
  };
  if (input.category !== undefined) metadata.category = input.category;
  if (input.tags !== undefined) metadata.tags = input.tags;
  if (input.tenant !== undefined) metadata.tenant = input.tenant;
  if (input.source !== undefined) metadata.source = input.source;
  return metadata;
}

function buildFilter(filter: RecallFilter): MetadataFilter {
  const out: MetadataFilter = {};
  if (filter.category !== undefined) out.category = filter.category;
  if (filter.tenant !== undefined) out.tenant = filter.tenant;
  return out;
}

// the memory's id is its metadata.memoryId; record.id is the vector record it lives in (the vectorId)
function toRecalled(record: RetrievedRecord, score?: number): RecalledMemory {
  const metadata = record.metadata as unknown as MemoryMetadata;
  const memory: RecalledMemory = {
    id: metadata.memoryId,
    vectorId: record.id,
    content: record.content,
    metadata,
  };
  if (score !== undefined) memory.score = score;
  return memory;
}
