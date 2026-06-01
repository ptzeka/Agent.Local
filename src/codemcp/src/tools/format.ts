import type { ChunkRow } from '../db/pgRepository.js';

/**
 * Format a chunk as an LLM-friendly block with line-anchored citation and
 * governing CLAUDE.md files. Designed so an assistant can quote the result
 * without hallucinating line numbers.
 */
export function formatChunk(chunk: ChunkRow): string {
  const symbolPart = chunk.symbol ? ` ${chunk.symbol}` : '';
  const parentPart = chunk.parentSymbol ? ` (in ${chunk.parentSymbol})` : '';
  const scorePart = chunk.score !== undefined ? `  score=${chunk.score.toFixed(4)}` : '';
  const claudePart = chunk.claudeMd.length > 0
    ? `governed by: ${chunk.claudeMd.join(', ')}\n`
    : '';
  return [
    `[${chunk.path}:${chunk.startLine}-${chunk.endLine}] (${chunk.language} ${chunk.kind})${symbolPart}${parentPart}${scorePart}`,
    `commit: ${chunk.commitSha}  area: ${chunk.area}`,
    claudePart + '---',
    chunk.content,
  ].join('\n');
}

export function formatChunks(chunks: ChunkRow[]): string {
  if (chunks.length === 0) return '(no results)';
  return chunks.map(formatChunk).join('\n\n');
}
