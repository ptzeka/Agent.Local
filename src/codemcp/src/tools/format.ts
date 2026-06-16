import type { ChunkRow, ChunkSummary } from '../retrieval/types.js';

// line-anchored citation + governing CLAUDE.md files, so an assistant can quote
// the result without hallucinating line numbers
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

// the locate-tier line: the same citation header as a chunk but no body — call expand_chunk on the
// [path:start-end] you want to read in full
export function formatSummary(summary: ChunkSummary): string {
  const symbolPart = summary.symbol ? ` ${summary.symbol}` : '';
  const parentPart = summary.parentSymbol ? ` (in ${summary.parentSymbol})` : '';
  const scorePart = summary.score !== undefined ? `  score=${summary.score.toFixed(4)}` : '';
  return `[${summary.path}:${summary.startLine}-${summary.endLine}] (${summary.language} ${summary.kind})${symbolPart}${parentPart}${scorePart}`;
}

export function formatSummaries(summaries: ChunkSummary[]): string {
  if (summaries.length === 0) return '(no results)';
  return summaries.map(formatSummary).join('\n');
}
