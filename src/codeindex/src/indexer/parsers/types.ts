import type { Area, CodeEdge, RawChunk } from '../../types.js';

export type ParserLanguage = 'typescript' | 'tsx' | 'javascript' | 'jsx';

export interface ParserInput {
  path: string;          // repo-relative, forward-slash
  absolutePath: string;
  area: Area;
  language: ParserLanguage;
  content: string;
}

export interface ParseResult {
  chunks: RawChunk[];
  edges: CodeEdge[];
}

// the seam that lets AST and regex extraction swap without callers noticing
export interface IParser {
  parse(input: ParserInput): ParseResult;
}
