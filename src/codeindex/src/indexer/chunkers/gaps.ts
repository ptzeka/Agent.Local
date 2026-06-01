// Gap-filler: ensures every line of a file is covered by some chunk.
//
// Symbol-based chunkers (csharp, typescript, proto) only emit chunks for
// declarations they recognize. That leaves file-level glue — imports, top-level
// constants, regex/literal tables, trailing setup code — invisible to the
// index. `get_file_context` then returns "all chunks for this file" but the
// chunks don't actually cover the whole file.
//
// fillFileGaps takes the symbol chunks, computes the line ranges they don't
// cover, and emits a synthetic `module` chunk for each gap whose content is
// not whitespace-only.

import type { Area, RawChunk } from '../../types.js';

export interface GapContext {
  path: string;
  area: Area;
  language: string;
  imports: string[];
}

export function fillFileGaps(
  symbolChunks: RawChunk[],
  lines: string[],
  ctx: GapContext,
): RawChunk[] {
  if (symbolChunks.length === 0) return symbolChunks;

  const sorted = [...symbolChunks].sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
  const out: RawChunk[] = [];
  let cursor = 1;

  for (const chunk of sorted) {
    if (chunk.startLine > cursor) {
      const gap = makeGapChunk(lines, cursor, chunk.startLine - 1, ctx, gapLabel(cursor));
      if (gap) out.push(gap);
    }
    out.push(chunk);
    cursor = Math.max(cursor, chunk.endLine + 1);
  }

  if (cursor <= lines.length) {
    const tail = makeGapChunk(lines, cursor, lines.length, ctx, '(tail)');
    if (tail) out.push(tail);
  }

  // Re-sort so module chunks appear in file order alongside symbol chunks.
  out.sort((a, b) => a.startLine - b.startLine);
  return out;
}

function gapLabel(cursorAtGapStart: number): string {
  return cursorAtGapStart === 1 ? '(preamble)' : '(gap)';
}

function makeGapChunk(
  lines: string[],
  startLine: number,
  endLine: number,
  ctx: GapContext,
  symbol: string,
): RawChunk | null {
  if (startLine > endLine) return null;
  const slice = lines.slice(startLine - 1, endLine);
  if (slice.join('').trim().length === 0) return null;
  return {
    path: ctx.path,
    area: ctx.area,
    language: ctx.language,
    kind: 'module',
    symbol,
    parentSymbol: null,
    startLine,
    endLine,
    content: slice.join('\n'),
    imports: ctx.imports,
  };
}
