import { describe, expect, test } from '@jest/globals';
import { RegexParser } from '../../src/indexer/parsers/regexParser.js';
import type { ParserInput } from '../../src/indexer/parsers/types.js';
import {
  ARROW_CONST_SRC,
  CLASS_SRC,
  FUNCTION_SRC,
  IMPORTS_SRC,
  INTERFACE_SRC,
  TSX_COMPONENT_SRC,
} from './fixtures.js';

function input(content: string, overrides: Partial<ParserInput> = {}): ParserInput {
  return {
    path: 'src/example.ts',
    absolutePath: '/repo/src/example.ts',
    area: 'backend',
    language: 'typescript',
    content,
    ...overrides,
  };
}

// locks in today's regex-heuristic behavior (chunkTypeScript) as the baseline RegexParser
// must keep reproducing — no test suite existed for this chunker before this change
describe('RegexParser', () => {
  const parser = new RegexParser();

  test('detects a top-level exported function', () => {
    const { chunks } = parser.parse(input(FUNCTION_SRC));
    const fn = chunks.find(c => c.symbol === 'add');
    expect(fn?.kind).toBe('function');
  });

  test('detects a class but NOT its methods as separate symbols (the known gap TreeLineParser fixes)', () => {
    const { chunks } = parser.parse(input(CLASS_SRC));
    const cls = chunks.find(c => c.symbol === 'Greeter');
    expect(cls?.kind).toBe('class');
    expect(chunks.find(c => c.symbol === 'greet')).toBeUndefined();
    expect(chunks.find(c => c.symbol === 'create')).toBeUndefined();
    expect(chunks.every(c => c.parentSymbol === null)).toBe(true);
  });

  test('detects an arrow-function const as a function', () => {
    const { chunks } = parser.parse(input(ARROW_CONST_SRC));
    const fn = chunks.find(c => c.symbol === 'multiply');
    expect(fn?.kind).toBe('function');
  });

  test('detects a capitalized arrow-function const in tsx as a component', () => {
    const { chunks } = parser.parse(input(TSX_COMPONENT_SRC, { language: 'tsx' }));
    const widget = chunks.find(c => c.symbol === 'Widget');
    expect(widget?.kind).toBe('component');
  });

  test('detects an interface', () => {
    const { chunks } = parser.parse(input(INTERFACE_SRC));
    const iface = chunks.find(c => c.symbol === 'Shape');
    expect(iface?.kind).toBe('interface');
  });

  test('extracts module-specifier-only imports onto every chunk', () => {
    const { chunks } = parser.parse(input(IMPORTS_SRC));
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk.imports).toEqual(['./foo', './bar']);
    }
  });

  test('emits module-level import edges with lexically resolved relative targets', () => {
    const { edges } = parser.parse(input(IMPORTS_SRC));
    expect(edges).toEqual([
      { from: 'src/example.ts', to: 'src/foo', type: 'imports', line: 1 },
      { from: 'src/example.ts', to: 'src/bar', type: 'imports', line: 2 },
    ]);
  });
});
