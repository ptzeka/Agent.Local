import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { CodeIndexConfig } from '../config.js';
import type { DbConnectionFactory } from '../db/types.js';
import type { PgWriterRepository } from '../db/pgRepository.js';
import type { IVectorService } from '@agent-local/vectorizer';
import type { ChunkRow, CommitRow, RawChunk } from '../types.js';
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
  factory: DbConnectionFactory;
  repo: PgWriterRepository;
  embedder: IVectorService;
  log?: (msg: string) => void;
}

export async function publish(deps: PublishDeps): Promise<PublishResult> {
  const { config, factory, repo, embedder } = deps;
  const log = deps.log ?? (() => undefined);

  const rootDir = resolve(config.rootDir);
  const git = readGitContext(rootDir, config.branch, config.repository);
  log(`indexing commit ${git.commitSha} (branch ${git.branch}, repository ${git.repository})${git.isDirty ? ' [dirty]' : ''}`);

  const files = walkRepository({ rootDir, excludeGlobs: config.excludeGlobs });
  log(`walked ${files.length} indexable files`);

  // Verify the on-disk schema matches the configured dimension before doing
  // any work.
  await using probeConn = await factory.getConnection();
  const onDiskDim = await repo.getEmbeddingDimension(probeConn);
  if (onDiskDim !== null && onDiskDim !== embedder.dim) {
    throw new Error(
      `Configured embed dim (${embedder.dim}) does not match the chunks.embedding column dim (${onDiskDim}). ` +
      `Either change CODEINDEX_EMBED_DIM or add a forward migration that ALTERs the column.`,
    );
  }

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

  const chunkRows: ChunkRow[] = [];
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
      chunkRows.push({
        path: raw.path,
        area: raw.area,
        language: raw.language,
        kind: raw.kind,
        symbol: raw.symbol,
        parentSymbol: raw.parentSymbol,
        startLine: raw.startLine,
        endLine: raw.endLine,
        content: raw.content,
        contentHash: sha256(raw.content),
        imports: raw.imports,
        claudeMd: claudeMdLineageForFile(rootDir, raw.path),
        embedding,
      });
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
    chunkCount: chunkRows.length,
  };

  await factory.withTransaction(async (conn) => {
    await repo.deleteChunksForCommit(conn, commit.commitSha);
    await repo.upsertCommit(conn, commit);
    await repo.insertChunks(conn, commit.commitSha, chunkRows);
  });

  log(`published ${chunkRows.length} chunks for ${commit.commitSha} (${commit.repository}) using ${embedder.modelId}`);
  return {
    commitSha: commit.commitSha,
    branch: commit.branch,
    repository: commit.repository,
    fileCount: commit.fileCount,
    chunkCount: commit.chunkCount,
    modelId: embedder.modelId,
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
