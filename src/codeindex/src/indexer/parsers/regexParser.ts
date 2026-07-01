import type { RawChunk } from '../../types.js';
import { chunkTypeScript } from '../chunkers/typescript.js';
import type { IParser, ParserInput } from './types.js';

// today's heuristic TS/JS chunker, wrapped behind IParser — the regression baseline and
// TreeLineParser's fallback when a file fails to parse
export class RegexParser implements IParser {
  parse(input: ParserInput): RawChunk[] {
    return chunkTypeScript({
      path: input.path,
      area: input.area,
      language: input.language,
      content: input.content,
    });
  }
}
