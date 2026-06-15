import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileVectorStore } from '@agent-local/vectorstore';
import { VectorService } from '@agent-local/vectorizer';
import { MemoryRepository } from '../memory/memoryRepository.js';

// local hashed embedder keeps the test offline and deterministic; recall ranking is exercised by
// keeping queries token-overlapping with the stored content (the real provider is voyage/openai)
function buildRepo(baseDir: string): MemoryRepository {
  const store = new FileVectorStore({ baseDir, partitionDir: 'memories', recordsFile: 'records.jsonl' });
  const embedder = VectorService.fromProvider('local', 64);
  return new MemoryRepository(store, embedder);
}

describe('MemoryRepository', () => {
  let dir: string;
  let repo: MemoryRepository;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'memomcp-'));
    repo = buildRepo(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns all core memories plus top-k archival on recall', async () => {
    await repo.remember('alice', { content: 'user prefers dark mode', kind: 'core' });
    await repo.remember('alice', { content: 'the deploy pipeline runs nightly at 2am', kind: 'archival' });
    await repo.remember('alice', { content: 'a quarterly budget review meeting', kind: 'archival' });

    const result = await repo.recall('alice', { query: 'when does the deploy pipeline run', k: 1 });

    expect(result.collection).toBe('alice');
    expect(result.core).toHaveLength(1);
    expect(result.core[0]!.content).toBe('user prefers dark mode');
    expect(result.archival).toHaveLength(1);
    expect(result.archival[0]!.content).toContain('deploy pipeline');
    expect(result.archival[0]!.score).toBeDefined();
  });

  it('partitions by collection', async () => {
    await repo.remember('alice', { content: 'alice memory', kind: 'core' });
    await repo.remember('bob', { content: 'bob memory', kind: 'core' });

    const alice = await repo.recall('alice', { query: 'memory', k: 5 });
    expect(alice.core.map((m) => m.content)).toEqual(['alice memory']);
  });

  it('overwrites a memory by id (upsert)', async () => {
    const id = await repo.remember('alice', { content: 'original', kind: 'core' });
    await repo.remember('alice', { content: 'updated', kind: 'core', id });

    const result = await repo.recall('alice', { query: 'anything', k: 5 });
    expect(result.core).toHaveLength(1);
    expect(result.core[0]!.content).toBe('updated');
  });

  it('narrows core and archival by category filter', async () => {
    await repo.remember('alice', { content: 'work note', kind: 'core', category: 'work' });
    await repo.remember('alice', { content: 'home note', kind: 'core', category: 'home' });
    await repo.remember('alice', { content: 'work archival item', kind: 'archival', category: 'work' });
    await repo.remember('alice', { content: 'home archival item', kind: 'archival', category: 'home' });

    const result = await repo.recall('alice', { query: 'note', k: 5, category: 'work' });
    expect(result.core.map((m) => m.content)).toEqual(['work note']);
    expect(result.archival.map((m) => m.content)).toEqual(['work archival item']);
  });

  it('stamps createdAt and kind metadata', async () => {
    await repo.remember('alice', { content: 'note', kind: 'core', tags: ['x'], tenant: 't1', source: 'chat' });
    const result = await repo.recall('alice', { query: 'note', k: 5 });
    const meta = result.core[0]!.metadata;
    expect(meta.kind).toBe('core');
    expect(meta.tags).toEqual(['x']);
    expect(meta.tenant).toBe('t1');
    expect(meta.source).toBe('chat');
    expect(typeof meta.createdAt).toBe('string');
  });

  it('exposes a vectorId distinct from the memory id, stable across overwrite', async () => {
    const memoryId = await repo.remember('alice', { content: 'first', kind: 'core' });
    const before = (await repo.recall('alice', { query: 'x', k: 1 })).core[0]!;
    expect(before.id).toBe(memoryId);
    expect(before.vectorId).toBeDefined();
    expect(before.vectorId).not.toBe(memoryId);

    await repo.remember('alice', { content: 'second', kind: 'core', id: memoryId });
    const after = (await repo.recall('alice', { query: 'x', k: 1 })).core[0]!;
    expect(after.id).toBe(memoryId);
    // re-embedding the same memory keeps its vector record identity
    expect(after.vectorId).toBe(before.vectorId);
    expect(after.content).toBe('second');
  });

  it('rejects empty content', async () => {
    await expect(repo.remember('alice', { content: '   ' })).rejects.toThrow(/empty/);
  });
});
