import type { Area, ChunkKind, RawChunk } from '../../types.js';
import { chunkFallback } from './fallback.js';
import { expandToLeadingComments } from './comments.js';
import { fillFileGaps } from './gaps.js';

export interface TypeScriptInput {
  path: string;
  area: Area;
  language: string;          // 'typescript' | 'tsx' | 'javascript' | 'jsx'
  content: string;
}

// Heuristic TS/JS chunker. Detects exported/top-level functions, classes,
// interfaces, type aliases, and React components. Falls back to the
// windowed chunker if nothing recognizable is found.

const IMPORT_RE = /^\s*import\s+(?:[^'"]+?\s+from\s+)?['"]([^'"]+)['"]\s*;?\s*$/;

interface TopDecl {
  kind: ChunkKind;
  symbol: string;
  startLine: number;
}

const PATTERNS: { re: RegExp; kind: ChunkKind; nameGroup: number }[] = [
  // export class Foo
  { re: /^\s*export\s+(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)/, kind: 'class', nameGroup: 1 },
  { re: /^\s*(?:abstract\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)/, kind: 'class', nameGroup: 1 },
  // export interface Foo
  { re: /^\s*export\s+interface\s+([A-Za-z_$][A-Za-z0-9_$]*)/, kind: 'interface', nameGroup: 1 },
  { re: /^\s*interface\s+([A-Za-z_$][A-Za-z0-9_$]*)/, kind: 'interface', nameGroup: 1 },
  // export function foo
  { re: /^\s*export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)/, kind: 'function', nameGroup: 1 },
  { re: /^\s*(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)/, kind: 'function', nameGroup: 1 },
  // export const Foo = (...) => ... or = function ...
  { re: /^\s*export\s+(?:default\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|<[^>]+>\s*\([^)]*\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*=>/, kind: 'function', nameGroup: 1 },
  { re: /^\s*export\s+(?:default\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=]+)?=\s*function/, kind: 'function', nameGroup: 1 },
];

export function chunkTypeScript(input: TypeScriptInput): RawChunk[] {
  const lines = input.content.split(/\r?\n/);

  const imports: string[] = [];
  for (const line of lines) {
    const m = IMPORT_RE.exec(line);
    if (m && m[1]) imports.push(m[1]);
  }

  const decls: TopDecl[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    for (const pattern of PATTERNS) {
      const m = pattern.re.exec(line);
      if (m) {
        const symbol = m[pattern.nameGroup];
        if (symbol) {
          // Component heuristic: capitalized name in .tsx/.jsx = component.
          const isComponent =
            (input.language === 'tsx' || input.language === 'jsx') &&
            /^[A-Z]/.test(symbol) &&
            pattern.kind === 'function';
          decls.push({
            kind: isComponent ? 'component' : pattern.kind,
            symbol,
            startLine: i + 1,
          });
          break;
        }
      }
    }
  }

  if (decls.length === 0) {
    return chunkFallback({
      path: input.path,
      area: input.area,
      language: input.language,
      content: input.content,
    });
  }

  // Determine end lines by walking brace depth from each declaration onward.
  const out: RawChunk[] = [];
  for (let i = 0; i < decls.length; i++) {
    const decl = decls[i]!;
    const nextStart = decls[i + 1]?.startLine ?? lines.length + 1;
    const endLine = findEndLine(lines, decl.startLine, nextStart);
    const startLine = expandToLeadingComments(lines, decl.startLine, 'cstyle');
    out.push({
      path: input.path,
      area: input.area,
      language: input.language,
      kind: decl.kind,
      symbol: decl.symbol,
      parentSymbol: null,
      startLine,
      endLine,
      content: lines.slice(startLine - 1, endLine).join('\n'),
      imports,
    });
  }
  return fillFileGaps(out, lines, {
    path: input.path,
    area: input.area,
    language: input.language,
    imports,
  });
}

function findEndLine(lines: string[], startLine: number, nextStart: number): number {
  // Track brace depth from startLine until depth returns to 0 having been
  // positive at some point. The termination check must happen at end-of-line,
  // not after each closing brace — otherwise patterns like `= {}` (empty
  // default object) on the signature line falsely close the function before
  // the body brace is even seen.
  let depth = 0;
  let opened = false;
  const limit = Math.min(nextStart - 1, lines.length);
  for (let i = startLine - 1; i < limit; i++) {
    const sanitized = stripStringsAndComments(lines[i] ?? '');
    for (const ch of sanitized) {
      if (ch === '{') { depth++; opened = true; }
      else if (ch === '}') { depth = Math.max(0, depth - 1); }
    }
    if (opened && depth === 0) return i + 1;
    // If the declaration ends with a semicolon and we never opened a brace,
    // it's a one-liner (`const foo = () => bar();`) — end at this line.
    if (!opened && sanitized.trimEnd().endsWith(';')) {
      return i + 1;
    }
  }
  return limit;
}

function stripStringsAndComments(line: string): string {
  let out = '';
  let i = 0;
  let inString: '"' | "'" | '`' | null = null;
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
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch as '"' | "'" | '`';
      out += ' ';
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}
