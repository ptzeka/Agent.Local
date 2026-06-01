import type { Area, ChunkKind, RawChunk } from '../../types.js';
import { chunkFallback } from './fallback.js';
import { expandToLeadingComments } from './comments.js';
import { fillFileGaps } from './gaps.js';

export interface ProtoInput {
  path: string;
  area: Area;
  content: string;
}

const HEADER_RE = /^\s*(message|service|enum|rpc)\s+([A-Za-z_][A-Za-z0-9_]*)/;
const IMPORT_RE = /^\s*import\s+(?:public\s+)?"([^"]+)"\s*;\s*$/;

export function chunkProto(input: ProtoInput): RawChunk[] {
  const lines = input.content.split(/\r?\n/);

  const imports: string[] = [];
  for (const line of lines) {
    const m = IMPORT_RE.exec(line);
    if (m && m[1]) imports.push(m[1]);
  }

  const decls: { kind: ChunkKind; symbol: string; startLine: number; endLine: number }[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const m = HEADER_RE.exec(line);
    if (m) {
      const word = m[1]!;
      const symbol = m[2]!;
      const kind: ChunkKind =
        word === 'message' ? 'message' :
        word === 'service' ? 'service' :
        word === 'rpc' ? 'rpc' :
        'message';

      // Find matching closing brace.
      const startLine = i + 1;
      let endLine = startLine;
      const braceIdx = line.indexOf('{');
      if (braceIdx === -1) {
        // Single-line rpc declaration or similar.
        endLine = startLine;
      } else {
        let depth = 0;
        let opened = false;
        for (let j = i; j < lines.length; j++) {
          const lj = lines[j] ?? '';
          for (const ch of stripQuotes(lj)) {
            if (ch === '{') { depth++; opened = true; }
            else if (ch === '}') depth--;
          }
          if (opened && depth === 0) { endLine = j + 1; break; }
        }
        if (!opened) endLine = startLine;
      }
      decls.push({ kind, symbol, startLine, endLine });
      i = endLine;
      continue;
    }
    i++;
  }

  if (decls.length === 0) {
    return chunkFallback({
      path: input.path,
      area: input.area,
      language: 'protobuf',
      content: input.content,
    });
  }

  const symbolChunks: RawChunk[] = decls.map(d => {
    const startLine = expandToLeadingComments(lines, d.startLine, 'cstyle');
    return {
      path: input.path,
      area: input.area,
      language: 'protobuf' as const,
      kind: d.kind,
      symbol: d.symbol,
      parentSymbol: null,
      startLine,
      endLine: d.endLine,
      content: lines.slice(startLine - 1, d.endLine).join('\n'),
      imports,
    };
  });

  return fillFileGaps(symbolChunks, lines, {
    path: input.path,
    area: input.area,
    language: 'protobuf',
    imports,
  });
}

function stripQuotes(line: string): string {
  // Remove "..."-delimited strings so braces inside don't confuse depth counting.
  let out = '';
  let inStr = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] ?? '';
    if (ch === '"') { inStr = !inStr; out += ' '; continue; }
    out += inStr ? ' ' : ch;
  }
  return out;
}
