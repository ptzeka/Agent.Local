import { chunkCSharp } from '../chunkers/csharp.js';
import type { IParser, ParseResult, ParserInput } from './types.js';

// CSharpTreeParser's fallback when a file fails to parse (or the AST yields no top-level type):
// the heuristic brace-block chunker, no edges since there's no AST to extract them from
export class CSharpFallbackParser implements IParser {
  parse(input: ParserInput): ParseResult {
    const chunks = chunkCSharp({ path: input.path, area: input.area, content: input.content });
    return { chunks, edges: [] };
  }
}
