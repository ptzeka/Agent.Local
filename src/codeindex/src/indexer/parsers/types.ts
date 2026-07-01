import type { Area, RawChunk } from '../../types.js';

export interface ParserInput {
  path: string;          // relativePath, forward-slash
  absolutePath: string;
  area: Area;
  language: string;      // 'typescript' | 'tsx' | 'javascript' | 'jsx'
  content: string;
}

// swappable TS/JS symbol extraction: RegexParser (heuristic, today's behavior)
// vs TreeLineParser (tree-sitter AST, exact class-method symbols)
export interface IParser {
  parse(input: ParserInput): RawChunk[];
}
