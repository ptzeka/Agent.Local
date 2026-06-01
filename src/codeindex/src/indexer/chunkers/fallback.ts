import type { Area, RawChunk } from '../../types.js';

const WINDOW_LINES = 60;
const OVERLAP_LINES = 10;

export interface FallbackInput {
  path: string;
  area: Area;
  language: string;
  content: string;
}

export function chunkFallback(input: FallbackInput): RawChunk[] {
  const lines = input.content.split(/\r?\n/);
  if (lines.length === 0) return [];

  // For very small files, emit a single chunk.
  if (lines.length <= WINDOW_LINES) {
    return [{
      path: input.path,
      area: input.area,
      language: input.language,
      kind: 'file',
      symbol: null,
      parentSymbol: null,
      startLine: 1,
      endLine: lines.length,
      content: input.content,
      imports: [],
    }];
  }

  const chunks: RawChunk[] = [];
  let start = 0;
  while (start < lines.length) {
    const end = Math.min(start + WINDOW_LINES, lines.length);
    const slice = lines.slice(start, end).join('\n');
    chunks.push({
      path: input.path,
      area: input.area,
      language: input.language,
      kind: 'window',
      symbol: null,
      parentSymbol: null,
      startLine: start + 1,
      endLine: end,
      content: slice,
      imports: [],
    });
    if (end >= lines.length) break;
    start = end - OVERLAP_LINES;
  }
  return chunks;
}
