import { describe, expect, jest, test } from '@jest/globals';
import { CSharpTreeParser } from '../../src/indexer/parsers/csharpTreeParser.js';
import { CSharpFallbackParser } from '../../src/indexer/parsers/csharpFallbackParser.js';
import type { IParser, ParseResult, ParserInput } from '../../src/indexer/parsers/types.js';

const CLASS_SRC = `namespace Demo
{
    public class Greeter
    {
        private readonly string name;

        public Greeter(string name)
        {
            this.name = name;
        }

        public string Greet()
        {
            return "Hello " + this.name;
        }

        public static Greeter Create()
        {
            return new Greeter("world");
        }
    }
}
`;

const INTERFACE_SRC = `namespace Demo
{
    public interface IShape
    {
        double Area();
    }
}
`;

const RECORD_SRC = `namespace Demo
{
    public record Point(int X, int Y);
}
`;

const FILE_SCOPED_NAMESPACE_SRC = `namespace Demo;

using System;

public class Widget
{
    public void Ping()
    {
        Console.WriteLine("ping");
    }
}
`;

const RELATIONSHIPS_SRC = `using System;
using System.Collections.Generic;

namespace Demo
{
    public class Thing : BaseThing, IThing
    {
        public void Run()
        {
            this.Step();
            Validate();
        }

        public void Step() { }

        private void Validate() { }
    }

    public static class Factory
    {
        public static Thing MakeThing()
        {
            return new Thing();
        }
    }
}
`;

const NO_SYMBOLS_SRC = `// just a comment, no declarations
`;

function input(content: string, path = 'src/Example.cs'): ParserInput {
  return {
    path,
    absolutePath: `/repo/${path}`,
    area: 'backend',
    language: 'csharp',
    content,
  };
}

describe('CSharpTreeParser', () => {
  const parser = new CSharpTreeParser(new CSharpFallbackParser());

  test('extracts a class and its methods as their own symbols, block namespace unwrapped', () => {
    const { chunks } = parser.parse(input(CLASS_SRC));

    const cls = chunks.find(c => c.symbol === 'Greeter' && c.kind === 'class');
    expect(cls).toBeDefined();
    expect(cls?.parentSymbol).toBeNull();

    const ctor = chunks.find(c => c.symbol === 'Greeter' && c.kind === 'method');
    const greet = chunks.find(c => c.symbol === 'Greet');
    const create = chunks.find(c => c.symbol === 'Create');

    for (const method of [ctor, greet, create]) {
      expect(method?.kind).toBe('method');
      expect(method?.parentSymbol).toBe('Greeter');
    }

    // each method's range is a strict, correctly-ordered subset of the class's range
    expect(greet!.startLine).toBeGreaterThan(cls!.startLine);
    expect(greet!.endLine).toBeLessThan(cls!.endLine);
  });

  test('detects an interface as a single chunk, without expanding its members', () => {
    const { chunks } = parser.parse(input(INTERFACE_SRC));
    const iface = chunks.find(c => c.symbol === 'IShape');
    expect(iface?.kind).toBe('interface');
    expect(chunks.find(c => c.symbol === 'Area')).toBeUndefined();
  });

  test('detects a bodyless record declaration as a single record chunk', () => {
    const { chunks } = parser.parse(input(RECORD_SRC));
    const record = chunks.find(c => c.symbol === 'Point');
    expect(record?.kind).toBe('record');
  });

  test('file-scoped namespace form yields the same extraction as block-scoped', () => {
    const { chunks } = parser.parse(input(FILE_SCOPED_NAMESPACE_SRC));
    const cls = chunks.find(c => c.symbol === 'Widget' && c.kind === 'class');
    const method = chunks.find(c => c.symbol === 'Ping');
    expect(cls).toBeDefined();
    expect(method?.parentSymbol).toBe('Widget');
  });

  test('using directives become import edges, resolved as external namespaces', () => {
    const { edges } = parser.parse(input(FILE_SCOPED_NAMESPACE_SRC));
    expect(edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 'src/Example.cs', to: 'external:System', type: 'imports' }),
    ]));
  });

  test('class heritage becomes extends/implements, disambiguated by the I<Upper> convention', () => {
    const { edges } = parser.parse(input(RELATIONSHIPS_SRC));
    expect(edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 'src/Example.cs#Thing', to: 'unresolved:BaseThing', type: 'extends' }),
      expect.objectContaining({ from: 'src/Example.cs#Thing', to: 'unresolved:IThing', type: 'implements' }),
    ]));
  });

  test('calls resolve to this.methods, bare same-type methods, and new-expressions', () => {
    const { edges } = parser.parse(input(RELATIONSHIPS_SRC));
    const calls = edges.filter(e => e.type === 'calls');
    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 'src/Example.cs#Thing.Run', to: 'src/Example.cs#Thing.Step' }),
      expect.objectContaining({ from: 'src/Example.cs#Thing.Run', to: 'src/Example.cs#Thing.Validate' }),
      expect.objectContaining({ from: 'src/Example.cs#Factory.MakeThing', to: 'src/Example.cs#Thing' }),
    ]));
  });

  test('falls back to the injected parser when nothing top-level is recognized', () => {
    const fakeResult: ParseResult = {
      chunks: [{
        path: 'x', area: 'backend', language: 'csharp', kind: 'module', symbol: null,
        parentSymbol: null, startLine: 1, endLine: 1, content: 'x', imports: [],
      }],
      edges: [],
    };
    const fallback: IParser = { parse: jest.fn().mockReturnValue(fakeResult) };
    const treeParser = new CSharpTreeParser(fallback);

    const result = treeParser.parse(input(NO_SYMBOLS_SRC));

    expect(fallback.parse).toHaveBeenCalledTimes(1);
    expect(result).toBe(fakeResult);
  });
});
