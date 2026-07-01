import { readFileSync } from 'node:fs';
import type { Area, RawChunk } from '../../types.js';
import { chunkMarkdown } from './markdown.js';
import { chunkCSharp } from './csharp.js';
import { chunkSql } from './sql.js';
import { chunkProto } from './proto.js';
import { chunkFallback } from './fallback.js';
import type { IParser } from '../parsers/types.js';

export interface ChunkFileInput {
  absolutePath: string;
  relativePath: string;   // forward-slash, relative to repo root
  area: Area;
  language: string;
}

// `parser` handles typescript/tsx/javascript/jsx only (the languages with a symbol-aware
// IParser split); every other language keeps its single regex chunker, dispatched here directly
export function chunkFile(input: ChunkFileInput, parser: IParser): RawChunk[] {
  const content = readFileSync(input.absolutePath, 'utf-8');
  switch (input.language) {
    case 'markdown':
      return chunkMarkdown({ path: input.relativePath, area: input.area, content });
    case 'csharp':
      return chunkCSharp({ path: input.relativePath, area: input.area, content });
    case 'typescript':
    case 'tsx':
    case 'javascript':
    case 'jsx':
      return parser.parse({
        path: input.relativePath,
        absolutePath: input.absolutePath,
        area: input.area,
        language: input.language,
        content,
      });
    case 'sql':
      return chunkSql({ path: input.relativePath, area: input.area, content });
    case 'protobuf':
      return chunkProto({ path: input.relativePath, area: input.area, content });
    default:
      return chunkFallback({ path: input.relativePath, area: input.area, language: input.language, content });
  }
}
