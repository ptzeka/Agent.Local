import type { CodeEdge } from '../../types.js';
import { chunkTypeScript } from '../chunkers/typescript.js';
import { importTargetId } from './entityIds.js';
import type { IParser, ParseResult, ParserInput } from './types.js';

const IMPORT_LINE_RE = /^\s*import\s+(?:[^'"]+?\s+from\s+)?['"]([^'"]+)['"]\s*;?\s*$/;

// today's heuristic TS/JS chunker, wrapped behind IParser — the regression baseline and
// TreeLineParser's fallback when a file fails to parse. Edge extraction is import-only:
// without an AST there is no reliable calls/implements detection
export class RegexParser implements IParser {
  parse(input: ParserInput): ParseResult {
    return {
      chunks: chunkTypeScript({
        path: input.path,
        area: input.area,
        language: input.language,
        content: input.content,
      }),
      edges: this.importEdges(input),
    };
  }

  private importEdges(input: ParserInput): CodeEdge[] {
    return input.content.split(/\r?\n/).flatMap((line, index) => {
      const match = IMPORT_LINE_RE.exec(line);
      if (!match?.[1]) return [];
      return [{
        from: input.path,
        to: importTargetId(input.path, match[1], input.language),
        type: 'imports' as const,
        line: index + 1,
      }];
    });
  }
}
