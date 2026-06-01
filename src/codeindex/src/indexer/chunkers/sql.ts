import type { Area, ChunkKind, RawChunk } from '../../types.js';
import { chunkFallback } from './fallback.js';
import { stripLeadingComments } from './comments.js';

export interface SqlInput {
  path: string;
  area: Area;
  content: string;
}

// Split on top-level semicolons (ignoring those inside strings and line
// comments) and pull out the object name from common DDL/DML headers.

const HEADER_RE = /^\s*(CREATE|ALTER|DROP|MERGE|WITH|INSERT|UPDATE|DELETE|SELECT)\b[\s\S]*?(?:(?:TABLE|VIEW|INDEX|FUNCTION|PROCEDURE|TRIGGER|SCHEMA|TYPE|EXTENSION|SEQUENCE)\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][\w\.]*))?/i;

export function chunkSql(input: SqlInput): RawChunk[] {
  const statements = splitStatements(input.content);
  if (statements.length === 0) {
    return chunkFallback({
      path: input.path,
      area: input.area,
      language: 'sql',
      content: input.content,
    });
  }

  return statements.map(stmt => {
    // Leading comments are already part of stmt.text (the splitter accumulates
    // them naturally). Strip them only for symbol extraction so the verb /
    // object name detector matches the underlying DDL keyword.
    const headerMatch = HEADER_RE.exec(stripLeadingComments(stmt.text, 'sql'));
    const symbol = headerMatch?.[2] ?? null;
    const verb = headerMatch?.[1]?.toUpperCase() ?? null;
    const kind: ChunkKind = 'statement';
    return {
      path: input.path,
      area: input.area,
      language: 'sql',
      kind,
      symbol: symbol ?? (verb ? `(${verb})` : null),
      parentSymbol: null,
      startLine: stmt.startLine,
      endLine: stmt.endLine,
      content: stmt.text,
      imports: [],
    };
  });
}

interface Statement { text: string; startLine: number; endLine: number; }

function splitStatements(source: string): Statement[] {
  const out: Statement[] = [];
  const lines = source.split(/\r?\n/);

  let buffer: string[] = [];
  let bufferStartLine = 1;
  let inSingle = false;
  let inDoubleDollar = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx] ?? '';
    inLineComment = false;
    let i = 0;
    while (i < line.length) {
      const ch = line[i] ?? '';
      const next = line[i + 1] ?? '';
      if (inLineComment) break;
      if (inBlockComment) {
        if (ch === '*' && next === '/') { inBlockComment = false; i += 2; continue; }
        i++; continue;
      }
      if (inSingle) {
        if (ch === "'" && next === "'") { i += 2; continue; }
        if (ch === "'") { inSingle = false; i++; continue; }
        i++; continue;
      }
      if (inDoubleDollar) {
        if (ch === '$' && next === '$') { inDoubleDollar = false; i += 2; continue; }
        i++; continue;
      }
      if (ch === '-' && next === '-') { inLineComment = true; break; }
      if (ch === '/' && next === '*') { inBlockComment = true; i += 2; continue; }
      if (ch === "'") { inSingle = true; i++; continue; }
      if (ch === '$' && next === '$') { inDoubleDollar = true; i += 2; continue; }
      if (ch === ';') {
        buffer.push(line.slice(0, i + 1));
        flush();
        const remainder = line.slice(i + 1);
        if (remainder.length > 0) buffer.push(remainder);
        bufferStartLine = lineIdx + 1;
        i = line.length;
        continue;
      }
      i++;
    }

    // End of line: anything from this line not already pushed becomes buffer.
    if (buffer.length === 0 || buffer[buffer.length - 1] !== line) {
      buffer.push(line);
    }
  }
  if (buffer.join('\n').trim().length > 0) flush();

  function flush(): void {
    const text = buffer.join('\n').trim();
    buffer = [];
    if (text.length === 0) return;
    out.push({
      text,
      startLine: bufferStartLine,
      endLine: Math.max(bufferStartLine, bufferStartLine + text.split('\n').length - 1),
    });
  }

  return out;
}
