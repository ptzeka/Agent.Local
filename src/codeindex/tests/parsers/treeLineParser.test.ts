import { describe, expect, jest, test } from '@jest/globals';
import { TreeLineParser } from '../../src/indexer/parsers/treeLineParser.js';
import { RegexParser } from '../../src/indexer/parsers/regexParser.js';
import type { IParser, ParserInput } from '../../src/indexer/parsers/types.js';
import type { RawChunk } from '../../src/types.js';
import {
  ARROW_CONST_SRC,
  ARROW_CONST_WITH_RETURN_TYPE_SRC,
  CLASS_SRC,
  FUNCTION_SRC,
  IMPORTS_SRC,
  INTERFACE_SRC,
  NO_SYMBOLS_SRC,
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

describe('TreeLineParser', () => {
  const parser = new TreeLineParser(new RegexParser());

  test('detects a top-level exported function (parity with RegexParser)', () => {
    const chunks = parser.parse(input(FUNCTION_SRC));
    const fn = chunks.find(c => c.symbol === 'add');
    expect(fn?.kind).toBe('function');
  });

  test('extracts class methods as their own symbols with exact line ranges — the fix over RegexParser', () => {
    const chunks = parser.parse(input(CLASS_SRC));

    const cls = chunks.find(c => c.symbol === 'Greeter' && c.kind === 'class');
    expect(cls).toBeDefined();
    expect(cls?.parentSymbol).toBeNull();

    const ctor = chunks.find(c => c.symbol === 'constructor');
    const greet = chunks.find(c => c.symbol === 'greet');
    const create = chunks.find(c => c.symbol === 'create');

    for (const method of [ctor, greet, create]) {
      expect(method?.kind).toBe('method');
      expect(method?.parentSymbol).toBe('Greeter');
    }

    // each method's range is a strict, correctly-ordered subset of the class's range
    const lines = CLASS_SRC.split('\n');
    const greetLine = lines.findIndex(l => l.includes('greet(): string')) + 1;
    expect(greet?.startLine).toBe(greetLine);
    expect(greet!.startLine).toBeGreaterThan(cls!.startLine);
    expect(greet!.endLine).toBeLessThan(cls!.endLine);
  });

  test('detects an arrow-function const as a function (parity with RegexParser)', () => {
    const chunks = parser.parse(input(ARROW_CONST_SRC));
    const fn = chunks.find(c => c.symbol === 'multiply');
    expect(fn?.kind).toBe('function');
  });

  test('detects an arrow-function const with a return-type annotation, unlike RegexParser', () => {
    const chunks = parser.parse(input(ARROW_CONST_WITH_RETURN_TYPE_SRC));
    const fn = chunks.find(c => c.symbol === 'divide');
    expect(fn?.kind).toBe('function');
  });

  test('detects a capitalized arrow-function const in tsx as a component (parity with RegexParser)', () => {
    const chunks = parser.parse(input(TSX_COMPONENT_SRC, { language: 'tsx' }));
    const widget = chunks.find(c => c.symbol === 'Widget');
    expect(widget?.kind).toBe('component');
  });

  test('detects an interface as a single chunk, without expanding its members (parity with RegexParser)', () => {
    const chunks = parser.parse(input(INTERFACE_SRC));
    const iface = chunks.find(c => c.symbol === 'Shape');
    expect(iface?.kind).toBe('interface');
    expect(chunks.find(c => c.symbol === 'area')).toBeUndefined();
  });

  test('extracts module-specifier-only imports onto every chunk (parity with RegexParser)', () => {
    const chunks = parser.parse(input(IMPORTS_SRC));
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk.imports).toEqual(['./foo', './bar']);
    }
  });

  test('falls back to the injected parser when nothing top-level is recognized', () => {
    const fakeChunks: RawChunk[] = [{
      path: 'x', area: 'backend', language: 'typescript', kind: 'module', symbol: null,
      parentSymbol: null, startLine: 1, endLine: 1, content: 'x', imports: [],
    }];
    const fallback: IParser = { parse: jest.fn().mockReturnValue(fakeChunks) };
    const treeParser = new TreeLineParser(fallback);

    const result = treeParser.parse(input(NO_SYMBOLS_SRC));

    expect(fallback.parse).toHaveBeenCalledTimes(1);
    expect(result).toBe(fakeChunks);
  });

  test('falls back to the injected parser when the language is unsupported', () => {
    const fakeChunks: RawChunk[] = [];
    const fallback: IParser = { parse: jest.fn().mockReturnValue(fakeChunks) };
    const treeParser = new TreeLineParser(fallback);

    const result = treeParser.parse(input(FUNCTION_SRC, { language: 'go' }));

    expect(fallback.parse).toHaveBeenCalledTimes(1);
    expect(result).toBe(fakeChunks);
  });
});
