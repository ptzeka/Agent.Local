import { describe, expect, jest, test } from '@jest/globals';
import { TreeLineParser } from '../../src/indexer/parsers/treeLineParser.js';
import { RegexParser } from '../../src/indexer/parsers/regexParser.js';
import type { IParser, ParseResult, ParserInput, ParserLanguage } from '../../src/indexer/parsers/types.js';
import {
  ARROW_CONST_SRC,
  ARROW_CONST_WITH_RETURN_TYPE_SRC,
  CLASS_SRC,
  CLASS_WITH_ARROW_FIELD_SRC,
  DOC_COMMENTED_METHOD_SRC,
  FUNCTION_SRC,
  IMPORTS_SRC,
  INTERFACE_SRC,
  NO_SYMBOLS_SRC,
  RELATIONSHIPS_SRC,
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
    const { chunks } = parser.parse(input(FUNCTION_SRC));
    const fn = chunks.find(c => c.symbol === 'add');
    expect(fn?.kind).toBe('function');
  });

  test('extracts class methods as their own symbols with exact line ranges — the fix over RegexParser', () => {
    const { chunks } = parser.parse(input(CLASS_SRC));

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

  test('an exported class chunk keeps the export keyword in its content', () => {
    const { chunks } = parser.parse(input(CLASS_SRC));
    const cls = chunks.find(c => c.kind === 'class');
    expect(cls?.content.startsWith('export class Greeter')).toBe(true);
  });

  test('an arrow-function class field becomes a method chunk; a plain field does not', () => {
    const { chunks } = parser.parse(input(CLASS_WITH_ARROW_FIELD_SRC));
    const onTick = chunks.find(c => c.symbol === 'onTick');
    expect(onTick?.kind).toBe('method');
    expect(onTick?.parentSymbol).toBe('Ticker');
    expect(chunks.find(c => c.symbol === 'limit')).toBeUndefined();
  });

  test('a method chunk starts at its leading doc comment, so docs travel with the symbol', () => {
    const { chunks } = parser.parse(input(DOC_COMMENTED_METHOD_SRC));
    const save = chunks.find(c => c.symbol === 'save');
    expect(save?.content).toContain('Saves the row.');
    expect(save?.startLine).toBe(2);
  });

  test('detects an arrow-function const as a function (parity with RegexParser)', () => {
    const { chunks } = parser.parse(input(ARROW_CONST_SRC));
    const fn = chunks.find(c => c.symbol === 'multiply');
    expect(fn?.kind).toBe('function');
  });

  test('detects an arrow-function const with a return-type annotation, unlike RegexParser', () => {
    const { chunks } = parser.parse(input(ARROW_CONST_WITH_RETURN_TYPE_SRC));
    const fn = chunks.find(c => c.symbol === 'divide');
    expect(fn?.kind).toBe('function');
  });

  test('detects a capitalized arrow-function const in tsx as a component (parity with RegexParser)', () => {
    const { chunks } = parser.parse(input(TSX_COMPONENT_SRC, { language: 'tsx' }));
    const widget = chunks.find(c => c.symbol === 'Widget');
    expect(widget?.kind).toBe('component');
  });

  test('detects an interface as a single chunk, without expanding its members (parity with RegexParser)', () => {
    const { chunks } = parser.parse(input(INTERFACE_SRC));
    const iface = chunks.find(c => c.symbol === 'Shape');
    expect(iface?.kind).toBe('interface');
    expect(chunks.find(c => c.symbol === 'area')).toBeUndefined();
  });

  test('extracts module-specifier-only imports onto every chunk (parity with RegexParser)', () => {
    const { chunks } = parser.parse(input(IMPORTS_SRC));
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk.imports).toEqual(['./foo', './bar']);
    }
  });

  test('falls back to the injected parser when nothing top-level is recognized', () => {
    const fakeResult: ParseResult = {
      chunks: [{
        path: 'x', area: 'backend', language: 'typescript', kind: 'module', symbol: null,
        parentSymbol: null, startLine: 1, endLine: 1, content: 'x', imports: [],
      }],
      edges: [],
    };
    const fallback: IParser = { parse: jest.fn().mockReturnValue(fakeResult) };
    const treeParser = new TreeLineParser(fallback);

    const result = treeParser.parse(input(NO_SYMBOLS_SRC));

    expect(fallback.parse).toHaveBeenCalledTimes(1);
    expect(result).toBe(fakeResult);
  });

  test('falls back to the injected parser when the language is unsupported', () => {
    const fakeResult: ParseResult = { chunks: [], edges: [] };
    const fallback: IParser = { parse: jest.fn().mockReturnValue(fakeResult) };
    const treeParser = new TreeLineParser(fallback);

    const result = treeParser.parse(input(FUNCTION_SRC, { language: 'go' as ParserLanguage }));

    expect(fallback.parse).toHaveBeenCalledTimes(1);
    expect(result).toBe(fakeResult);
  });

  test('import bindings become per-symbol edges: named, aliased default target, and external', () => {
    const { edges } = parser.parse(input(RELATIONSHIPS_SRC));
    const importTargets = edges.filter(e => e.type === 'imports').map(e => e.to);
    // relative `.js` specifiers resolve to the `.ts` source entity so edges join indexed files
    expect(importTargets).toEqual(expect.arrayContaining([
      'src/contracts.ts#BaseThing',
      'src/contracts.ts#IThing',
      'util/helper.ts#default',
      'external:zod#z',
    ]));
  });

  test('class heritage becomes extends/implements edges resolved through import bindings', () => {
    const { edges } = parser.parse(input(RELATIONSHIPS_SRC));
    expect(edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 'src/example.ts#Thing', to: 'src/contracts.ts#BaseThing', type: 'extends' }),
      expect.objectContaining({ from: 'src/example.ts#Thing', to: 'src/contracts.ts#IThing', type: 'implements' }),
    ]));
  });

  test('calls resolve to same-file symbols, this.methods, imported bindings, and new-expressions', () => {
    const { edges } = parser.parse(input(RELATIONSHIPS_SRC));
    const calls = edges.filter(e => e.type === 'calls');
    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 'src/example.ts#makeThing', to: 'src/example.ts#Thing' }),
      expect.objectContaining({ from: 'src/example.ts#Thing.run', to: 'src/example.ts#Thing.step' }),
      expect.objectContaining({ from: 'src/example.ts#Thing.run', to: 'util/helper.ts#default' }),
      expect.objectContaining({ from: 'src/example.ts#Thing.step', to: 'src/example.ts#makeThing' }),
    ]));
  });

  test('only resolvable calls become edges — the factory new-expression, nothing else', () => {
    const { edges } = parser.parse(input(CLASS_SRC));
    expect(edges.filter(e => e.type === 'calls')).toEqual([
      { from: 'src/example.ts#Greeter.create', to: 'src/example.ts#Greeter', type: 'calls', line: 9 },
    ]);
  });
});
