import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { CodeIndexConfig } from '../config.js';
import type { DbConnectionFactory, IVectorStore, VectorRecord } from '@agent-local/vectorstore';
import type { CommitRepository } from '../db/pgRepository.js';
import type { IVectorService } from '@agent-local/vectorizer';
import type { CommitRow, RawChunk } from '../types.js';
import { walkRepository } from '../indexer/walker.js';
import { chunkFile } from '../indexer/chunkers/index.js';
import { areaForPath, claudeMdLineageForFile, languageForPath } from '../indexer/metadata.js';
import { readGitContext } from './git.js';

const EMBED_BATCH_SIZE = 32;

export interface PublishResult {
  commitSha: string;
  branch: string;
  repository: string;
  fileCount: number;
  chunkCount: number;
  modelId: string;
}

export interface PublishDeps {
  config: CodeIndexConfig;
  vectorStore: IVectorStore;
  factory: DbConnectionFactory;
  repo: CommitRepository;
  embedder: IVectorService;
  log?: (msg: string) => void;
}

export async function publish(deps: PublishDeps): Promise<PublishResult> {
  const { config, vectorStore, factory, repo, embedder } = deps;
  const log = deps.log ?? (() => undefined);

  const rootDir = resolve(config.rootDir);
  const git = readGitContext(rootDir, config.branch, config.repository);
  log(`indexing commit ${git.commitSha} (branch ${git.branch}, repository ${git.repository})${git.isDirty ? ' [dirty]' : ''}`);

  const files = walkRepository({ rootDir, excludeGlobs: config.excludeGlobs });
  log(`walked ${files.length} indexable files`);

  const rawChunks: RawChunk[] = [];
  for (const file of files) {
    const language = languageForPath(file.relativePath);
    const area = areaForPath(file.relativePath);
    try {
      const fileChunks = chunkFile({
        absolutePath: file.absolutePath,
        relativePath: file.relativePath,
        area,
        language,
      });
      rawChunks.push(...fileChunks);
    } catch (err) {
      log(`WARN  failed to chunk ${file.relativePath}: ${(err as Error).message}`);
    }
  }
  log(`produced ${rawChunks.length} raw chunks`);

  const records: VectorRecord[] = [];
  for (let i = 0; i < rawChunks.length; i += EMBED_BATCH_SIZE) {
    const batch = rawChunks.slice(i, i + EMBED_BATCH_SIZE);
    const texts = batch.map(b => embedInputFor(b));
    const vectors = await embedder.embedBatch(texts);
    if (vectors.length !== batch.length) {
      throw new Error(`Embed adapter returned ${vectors.length} vectors for ${batch.length} inputs`);
    }
    for (let j = 0; j < batch.length; j++) {
      const raw = batch[j]!;
      const embedding = vectors[j]!;
      if (embedding.length !== embedder.dim) {
        throw new Error(`Embedding has dim ${embedding.length}, expected ${embedder.dim}`);
      }
      records.push(toRecord(rootDir, git.commitSha, raw, embedding));
    }
    log(`embedded ${Math.min(i + EMBED_BATCH_SIZE, rawChunks.length)}/${rawChunks.length}`);
  }

  const commit: CommitRow = {
    commitSha: git.commitSha,
    branch: git.branch,
    repository: git.repository,
    embedModel: embedder.modelId,
    embedDim: embedder.dim,
    fileCount: files.length,
    chunkCount: records.length,
  };

  // chunks first: a fresh namespace then upsert is the idempotent republish; the
  // file backend co-locates chunks.jsonl + commit.json under commits/<sha>/, and
  // deleteNamespace clears the dir, so commit metadata must be written afterwards
  await vectorStore.deleteNamespace(commit.commitSha);
  await vectorStore.upsert(records);
  await factory.withTransaction(conn => repo.upsertCommit(conn, commit));

  log(`published ${records.length} chunks for ${commit.commitSha} (${commit.repository}) using ${embedder.modelId}`);
  return {
    commitSha: commit.commitSha,
    branch: commit.branch,
    repository: commit.repository,
    fileCount: commit.fileCount,
    chunkCount: commit.chunkCount,
    modelId: embedder.modelId,
  };
}

// code fields collapse into the generic record's opaque metadata; id is stable
// per chunk so a republish of the same commit upserts in place
function toRecord(rootDir: string, commitSha: string, raw: RawChunk, embedding: number[]): VectorRecord {
  return {
    id: `${raw.path}#${raw.startLine}-${raw.endLine}`,
    namespace: commitSha,
    content: raw.content,
    embedding,
    metadata: {
      path: raw.path,
      area: raw.area,
      language: raw.language,
      kind: raw.kind,
      symbol: raw.symbol,
      parentSymbol: raw.parentSymbol,
      startLine: raw.startLine,
      endLine: raw.endLine,
      contentHash: sha256(raw.content),
      imports: raw.imports,
      claudeMd: claudeMdLineageForFile(rootDir, raw.path),
    },
  };
}

function embedInputFor(raw: RawChunk): string {
  // Prefix structural context so the embedder gets some semantic anchoring
  // (file path, symbol) along with the raw text.
  const header = [
    `path: ${raw.path}`,
    `lang: ${raw.language}`,
    `kind: ${raw.kind}`,
    raw.symbol ? `symbol: ${raw.symbol}` : null,
    raw.parentSymbol ? `parent: ${raw.parentSymbol}` : null,
  ].filter(Boolean).join('\n');
  return `${header}\n---\n${raw.content}`;
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
