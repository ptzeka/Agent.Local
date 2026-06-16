import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileVectorStore } from '@agent-local/vectorstore';
import { VectorService } from '@agent-local/vectorizer';
import { MemoryRepository } from '../memory/memoryRepository.js';
import { LocalReranker } from '../rerank/localReranker.js';

// local hashed embedder keeps the test offline and deterministic; recall ranking is exercised by
// keeping queries token-overlapping with the stored content (the real provider is voyage/openai)
function buildRepo(baseDir: string, withReranker = false): MemoryRepository {
  const store = new FileVectorStore({ baseDir, partitionDir: 'memories', recordsFile: 'records.jsonl' });
  const embedder = VectorService.fromProvider('local', 64);
  return new MemoryRepository(store, embedder, withReranker ? new LocalReranker() : undefined);
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

  describe('recall with rank=true', () => {
    let ranked: MemoryRepository;

    beforeEach(async () => {
      ranked = buildRepo(dir, true);
      await ranked.remember('alice', { content: 'the deploy pipeline runs nightly at 2am', kind: 'archival' });
      await ranked.remember('alice', { content: 'a quarterly budget review meeting', kind: 'archival' });
      await ranked.remember('alice', { content: 'kubernetes ingress configuration notes', kind: 'archival' });
    });

    it('orders archival by reranker relevance and stamps rerankScore', async () => {
      const result = await ranked.recall('alice', { query: 'deploy pipeline schedule', k: 3, rank: true });

      // the lexical-overlap reranker promotes the deploy-pipeline memory to the top regardless of cosine order
      expect(result.archival[0]!.content).toContain('deploy pipeline');
      expect(result.archival[0]!.rerankScore).toBeDefined();
      // ordered by descending rerank score
      const scores = result.archival.map((m) => m.rerankScore!);
      expect(scores).toEqual([...scores].sort((a, b) => b - a));
    });

    it('trims to k after over-fetching candidates', async () => {
      const result = await ranked.recall('alice', { query: 'deploy pipeline schedule', k: 1, rank: true });
      expect(result.archival).toHaveLength(1);
      expect(result.archival[0]!.content).toContain('deploy pipeline');
    });

    it('leaves cosine ordering untouched when rank is omitted', async () => {
      const cosine = await ranked.recall('alice', { query: 'deploy pipeline schedule', k: 3 });
      expect(cosine.archival.every((m) => m.rerankScore === undefined)).toBe(true);
    });

    it('ignores rank=true when no reranker is wired', async () => {
      const noReranker = buildRepo(dir);
      const result = await noReranker.recall('alice', { query: 'deploy pipeline schedule', k: 3, rank: true });
      expect(result.archival.every((m) => m.rerankScore === undefined)).toBe(true);
    });
  });

  it('locate returns content-free summaries mirroring recall, then expand pulls the bodies', async () => {
    await repo.remember('alice', { content: 'user prefers dark mode', kind: 'core' });
    await repo.remember('alice', { content: 'the deploy pipeline runs nightly at 2am', kind: 'archival' });
    await repo.remember('alice', { content: 'a quarterly budget review meeting', kind: 'archival' });

    const located = await repo.locate('alice', { query: 'when does the deploy pipeline run', k: 1 });

    // same core + top-k archival split as recall
    expect(located.collection).toBe('alice');
    expect(located.core).toHaveLength(1);
    expect(located.archival).toHaveLength(1);
    expect(located.archival[0]!.score).toBeDefined();

    // summaries carry identity + metadata but NO content body
    const coreSummary = located.core[0]!;
    expect(coreSummary.id).toBeDefined();
    expect(coreSummary.vectorId).toBeDefined();
    expect(coreSummary.metadata.kind).toBe('core');
    expect((coreSummary as unknown as { content?: unknown }).content).toBeUndefined();

    // expand the chosen vectorId -> the same body recall would have returned
    const expanded = await repo.expand('alice', [coreSummary.vectorId, located.archival[0]!.vectorId]);
    expect(expanded.map((m) => m.content)).toEqual(
      expect.arrayContaining(['user prefers dark mode', 'the deploy pipeline runs nightly at 2am']),
    );
    expect(expanded.find((m) => m.id === coreSummary.id)!.vectorId).toBe(coreSummary.vectorId);
  });

  it('locate honours the category filter like recall', async () => {
    await repo.remember('alice', { content: 'work note', kind: 'core', category: 'work' });
    await repo.remember('alice', { content: 'home note', kind: 'core', category: 'home' });
    await repo.remember('alice', { content: 'work archival item', kind: 'archival', category: 'work' });

    const located = await repo.locate('alice', { query: 'note', k: 5, category: 'work' });
    expect(located.core.map((s) => s.metadata.category)).toEqual(['work']);
    expect(located.archival.every((s) => s.metadata.category === 'work')).toBe(true);
  });

  it('expand skips unknown ids and returns empty when none resolve', async () => {
    await repo.remember('alice', { content: 'only memory', kind: 'core' });
    const located = await repo.locate('alice', { query: 'memory', k: 5 });

    const mixed = await repo.expand('alice', ['does-not-exist', located.core[0]!.vectorId]);
    expect(mixed.map((m) => m.content)).toEqual(['only memory']);

    const none = await repo.expand('alice', ['nope-1', 'nope-2']);
    expect(none).toEqual([]);
  });
});
