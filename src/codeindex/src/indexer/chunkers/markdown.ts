import type { Area, RawChunk } from '../../types.js';

export interface MarkdownInput {
  path: string;
  area: Area;
  content: string;
}

const HEADER_RE = /^(#{1,6})\s+(.+?)\s*$/;

interface HeaderRange {
  level: number;
  title: string;
  startLine: number;   // 1-based
  endLine: number;     // inclusive
}

export function chunkMarkdown(input: MarkdownInput): RawChunk[] {
  const lines = input.content.split(/\r?\n/);
  const headers: { level: number; title: string; line: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const m = HEADER_RE.exec(line);
    if (m) {
      headers.push({ level: m[1]!.length, title: m[2]!, line: i + 1 });
    }
  }

  if (headers.length === 0) {
    // No headers — treat the whole file as a single chunk.
    return [{
      path: input.path,
      area: input.area,
      language: 'markdown',
      kind: 'file',
      symbol: null,
      parentSymbol: null,
      startLine: 1,
      endLine: lines.length,
      content: input.content,
      imports: [],
    }];
  }

  const ranges: HeaderRange[] = headers.map((h, i) => {
    const next = headers[i + 1];
    return {
      level: h.level,
      title: h.title,
      startLine: h.line,
      endLine: next ? next.line - 1 : lines.length,
    };
  });

  // Optional preamble before the first header.
  const first = headers[0]!;
  const out: RawChunk[] = [];
  if (first.line > 1) {
    const preamble = lines.slice(0, first.line - 1).join('\n').trim();
    if (preamble.length > 0) {
      out.push({
        path: input.path,
        area: input.area,
        language: 'markdown',
        kind: 'section',
        symbol: '(preamble)',
        parentSymbol: null,
        startLine: 1,
        endLine: first.line - 1,
        content: lines.slice(0, first.line - 1).join('\n'),
        imports: [],
      });
    }
  }

  const titleStack: { level: number; title: string }[] = [];
  for (const range of ranges) {
    while (titleStack.length > 0 && (titleStack[titleStack.length - 1]?.level ?? 0) >= range.level) {
      titleStack.pop();
    }
    const parent = titleStack.length > 0 ? titleStack[titleStack.length - 1]?.title ?? null : null;
    titleStack.push({ level: range.level, title: range.title });

    out.push({
      path: input.path,
      area: input.area,
      language: 'markdown',
      kind: 'section',
      symbol: range.title,
      parentSymbol: parent,
      startLine: range.startLine,
      endLine: range.endLine,
      content: lines.slice(range.startLine - 1, range.endLine).join('\n'),
      imports: [],
    });
  }

  return out;
}
