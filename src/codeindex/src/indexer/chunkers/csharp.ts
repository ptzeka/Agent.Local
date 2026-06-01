import type { Area, ChunkKind, RawChunk } from '../../types.js';
import { chunkFallback } from './fallback.js';
import { expandToLeadingComments } from './comments.js';
import { fillFileGaps } from './gaps.js';

export interface CSharpInput {
  path: string;
  area: Area;
  content: string;
}

// Heuristic C# chunker. Tree-sitter would be more accurate, but we want a
// dependency-light path that works on Windows without native bindings. The
// goal is to produce *useful* retrievable units, not a perfect parse.
//
// Detected forms:
//   - class / record / struct / interface declarations
//   - method / constructor declarations inside classes
//   - top-level methods (file-scoped)
//
// Anything we can't classify falls through to the windowed fallback so we
// never silently drop content.

interface Decl {
  kind: ChunkKind;
  symbol: string;
  startLine: number;  // 1-based
}

const TYPE_DECL_RE = /^\s*(?:public|private|internal|protected|static|abstract|sealed|partial|\s)*\s*(class|record|struct|interface)\s+([A-Za-z_][A-Za-z0-9_]*)/;
const METHOD_DECL_RE = /^\s*(?:public|private|internal|protected|static|virtual|override|async|sealed|abstract|new|extern|partial|\s)*\s*(?:[A-Za-z_<>?,\[\]\.\s]+?)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\([^;]*\)\s*(?:where[^{;]+)?\s*[{=]/;
const USING_RE = /^\s*using\s+(?:static\s+)?([A-Za-z_][A-Za-z0-9_\.]*)\s*;\s*$/;

export function chunkCSharp(input: CSharpInput): RawChunk[] {
  const lines = input.content.split(/\r?\n/);

  const imports: string[] = [];
  for (const line of lines) {
    const m = USING_RE.exec(line);
    if (m && m[1]) imports.push(m[1]);
  }

  const blocks = extractBraceBlocks(lines);
  if (blocks.length === 0) {
    return chunkFallback({
      path: input.path,
      area: input.area,
      language: 'csharp',
      content: input.content,
    });
  }

  const out: RawChunk[] = [];
  for (const block of blocks) {
    const headerLine = lines[block.startLine - 1] ?? '';
    let decl: Decl | null = null;

    const typeMatch = TYPE_DECL_RE.exec(headerLine);
    if (typeMatch) {
      const kindWord = typeMatch[1]!;
      const symbol = typeMatch[2]!;
      const kind: ChunkKind =
        kindWord === 'class' ? 'class' :
        kindWord === 'record' ? 'record' :
        kindWord === 'interface' ? 'interface' :
        'class';
      decl = { kind, symbol, startLine: block.startLine };
    } else {
      const methodMatch = METHOD_DECL_RE.exec(headerLine);
      if (methodMatch && !/^\s*(?:if|for|foreach|while|switch|using|lock|fixed|try|catch|finally|do)\b/.test(headerLine)) {
        decl = { kind: 'method', symbol: methodMatch[1]!, startLine: block.startLine };
      }
    }

    if (!decl) continue;

    const parentSymbol = findEnclosingType(blocks, block, lines);
    const startLine = expandToLeadingComments(lines, block.startLine, 'cstyle');
    out.push({
      path: input.path,
      area: input.area,
      language: 'csharp',
      kind: decl.kind,
      symbol: decl.symbol,
      parentSymbol,
      startLine,
      endLine: block.endLine,
      content: lines.slice(startLine - 1, block.endLine).join('\n'),
      imports,
    });
  }

  if (out.length === 0) {
    return chunkFallback({
      path: input.path,
      area: input.area,
      language: 'csharp',
      content: input.content,
    });
  }
  return fillFileGaps(out, lines, {
    path: input.path,
    area: input.area,
    language: 'csharp',
    imports,
  });
}

interface BraceBlock {
  startLine: number;  // 1-based, the line containing the declaration header
  bodyStart: number;  // 1-based, line containing '{'
  endLine: number;    // 1-based, line containing the matching '}'
  depth: number;
}

function extractBraceBlocks(lines: string[]): BraceBlock[] {
  // Strip strings and comments cheaply so braces in them don't confuse us.
  const sanitized = lines.map(stripStringsAndComments);

  const blocks: BraceBlock[] = [];
  const open: { headerLine: number; bodyStart: number; depth: number }[] = [];
  let depth = 0;

  for (let i = 0; i < sanitized.length; i++) {
    const line = sanitized[i] ?? '';
    let pendingHeaderLine: number | null = null;

    // A declaration header is a non-blank line preceding the '{' that we
    // attribute the block to. Walk back to find it.
    for (let c = 0; c < line.length; c++) {
      const ch = line[c];
      if (ch === '{') {
        if (pendingHeaderLine === null) {
          pendingHeaderLine = findHeaderLine(sanitized, i);
        }
        open.push({ headerLine: pendingHeaderLine, bodyStart: i + 1, depth });
        depth++;
      } else if (ch === '}') {
        depth = Math.max(0, depth - 1);
        const top = open.pop();
        if (top) {
          blocks.push({
            startLine: top.headerLine,
            bodyStart: top.bodyStart,
            endLine: i + 1,
            depth: top.depth,
          });
        }
      }
    }
  }
  // Sort by start line for deterministic output.
  blocks.sort((a, b) => a.startLine - b.startLine);
  return blocks;
}

function findHeaderLine(sanitized: string[], braceLine: number): number {
  // The header is on this line if it has anything before '{', otherwise walk
  // backwards through blank lines to the first non-blank line.
  const line = sanitized[braceLine] ?? '';
  const idx = line.indexOf('{');
  if (idx > 0 && line.slice(0, idx).trim().length > 0) return braceLine + 1;
  for (let i = braceLine - 1; i >= 0; i--) {
    const candidate = sanitized[i] ?? '';
    if (candidate.trim().length > 0) return i + 1;
  }
  return braceLine + 1;
}

function findEnclosingType(blocks: BraceBlock[], inner: BraceBlock, lines: string[]): string | null {
  // The enclosing type is the smallest type-declaring block strictly containing `inner`.
  const candidates = blocks.filter(b =>
    b !== inner &&
    b.startLine < inner.startLine &&
    b.endLine > inner.endLine,
  );
  candidates.sort((a, b) => (b.startLine - a.startLine));
  for (const c of candidates) {
    const header = lines[c.startLine - 1] ?? '';
    const m = TYPE_DECL_RE.exec(header);
    if (m && m[2]) return m[2];
  }
  return null;
}

function stripStringsAndComments(line: string): string {
  let out = '';
  let i = 0;
  let inString: '"' | "'" | null = null;
  while (i < line.length) {
    const ch = line[i] ?? '';
    if (inString) {
      if (ch === '\\') { out += '  '; i += 2; continue; }
      if (ch === inString) { inString = null; out += ' '; i++; continue; }
      out += ' ';
      i++;
      continue;
    }
    if (ch === '/' && line[i + 1] === '/') {
      return out + ' '.repeat(line.length - i);
    }
    if (ch === '"' || ch === "'") {
      inString = ch;
      out += ' ';
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}
