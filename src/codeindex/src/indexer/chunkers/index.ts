import { readFileSync } from 'node:fs';
import type { Area, RawChunk } from '../../types.js';
import { chunkMarkdown } from './markdown.js';
import { chunkSql } from './sql.js';
import { chunkProto } from './proto.js';
import { chunkFallback } from './fallback.js';
import type { IParser, ParseResult } from '../parsers/types.js';

export interface ChunkFileInput {
  absolutePath: string;
  relativePath: string;   // forward-slash, relative to repo root
  area: Area;
  language: string;
}

// `parser` handles every language with a symbol-aware IParser split (typescript/tsx/
// javascript/jsx/csharp); every other language keeps its single regex chunker, dispatched
// here directly — those emit no edges until they grow their own relationship extraction
export function chunkFile(input: ChunkFileInput, parser: IParser): ParseResult {
  const content = readFileSync(input.absolutePath, 'utf-8');
  switch (input.language) {
    case 'markdown':
      return withoutEdges(chunkMarkdown({ path: input.relativePath, area: input.area, content }));
    case 'typescript':
    case 'tsx':
    case 'javascript':
    case 'jsx':
    case 'csharp':
      return parser.parse({
        path: input.relativePath,
        absolutePath: input.absolutePath,
        area: input.area,
        language: input.language,
        content,
      });
    case 'sql':
      return withoutEdges(chunkSql({ path: input.relativePath, area: input.area, content }));
    case 'protobuf':
      return withoutEdges(chunkProto({ path: input.relativePath, area: input.area, content }));
    default:
      return withoutEdges(chunkFallback({ path: input.relativePath, area: input.area, language: input.language, content }));
  }
}

function withoutEdges(chunks: RawChunk[]): ParseResult {
  return { chunks, edges: [] };
}
