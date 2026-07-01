import Parser from 'tree-sitter';
import TS_GRAMMARS from 'tree-sitter-typescript';
import JS_LANG from 'tree-sitter-javascript';

const TS_LANG = TS_GRAMMARS.typescript;
const TSX_LANG = TS_GRAMMARS.tsx;
import type { ChunkKind, RawChunk } from '../../types.js';
import { expandToLeadingComments } from '../chunkers/comments.js';
import { fillFileGaps } from '../chunkers/gaps.js';
import type { IParser, ParserInput } from './types.js';

type SyntaxNode = Parser.SyntaxNode;

const TOP_LEVEL_KIND: Record<string, ChunkKind> = {
  function_declaration: 'function',
  interface_declaration: 'interface',
};

// tree-sitter AST parser for TS/JS: walks the real syntax tree so class methods become their
// own symbols with exact line ranges, instead of the regex chunker's top-level-only view.
// Falls back to `fallback` (RegexParser) on a parse exception or when nothing is recognized.
export class TreeLineParser implements IParser {
  private readonly parser = new Parser();

  constructor(private readonly fallback: IParser) {}

  parse(input: ParserInput): RawChunk[] {
    try {
      return this.parseWithTree(input);
    } catch {
      return this.fallback.parse(input);
    }
  }

  private parseWithTree(input: ParserInput): RawChunk[] {
    this.parser.setLanguage(this.languageFor(input.language));
    const tree = this.parser.parse(input.content);
    const lines = input.content.split(/\r?\n/);
    const imports = this.collectImports(tree.rootNode);
    const chunks: RawChunk[] = [];

    for (const child of tree.rootNode.namedChildren) {
      this.collectTopLevel(child, input, lines, imports, chunks);
    }

    if (chunks.length === 0) {
      return this.fallback.parse(input);
    }
    return fillFileGaps(chunks, lines, {
      path: input.path,
      area: input.area,
      language: input.language,
      imports,
    });
  }

  private languageFor(language: string): Parser.Language {
    switch (language) {
      case 'typescript': return TS_LANG;
      case 'tsx': return TSX_LANG;
      case 'javascript':
      case 'jsx':
        return JS_LANG;
      default:
        throw new Error(`TreeLineParser: unsupported language ${language}`);
    }
  }

  // unwraps `export`/`export default` so the declaration underneath is inspected, while the
  // outer export_statement's own range still becomes the chunk's line span (keeps the keyword)
  private collectTopLevel(
    node: SyntaxNode,
    input: ParserInput,
    lines: string[],
    imports: string[],
    out: RawChunk[],
  ): void {
    const outer = node;
    const decl = node.type === 'export_statement' ? (node.childForFieldName('declaration') ?? node) : node;

    if (decl.type === 'class_declaration' || decl.type === 'abstract_class_declaration') {
      this.pushClassAndMethods(outer, decl, input, lines, imports, out);
      return;
    }

    const kind = TOP_LEVEL_KIND[decl.type];
    if (kind) {
      const name = decl.childForFieldName('name');
      if (name) out.push(this.buildChunk(outer, kind, name.text, null, input, lines, imports));
      return;
    }

    if (decl.type === 'lexical_declaration') {
      for (const declarator of decl.namedChildren) {
        if (declarator.type !== 'variable_declarator') continue;
        const name = declarator.childForFieldName('name');
        const value = declarator.childForFieldName('value');
        if (!name || !value) continue;
        if (value.type !== 'arrow_function' && value.type !== 'function_expression') continue;
        const isComponent =
          (input.language === 'tsx' || input.language === 'jsx') && /^[A-Z]/.test(name.text);
        // a multi-declarator `const a = ..., b = ...` uses the whole lexical_declaration's range
        // for each — rare enough in this codebase's style not to special-case further
        out.push(this.buildChunk(outer, isComponent ? 'component' : 'function', name.text, null, input, lines, imports));
      }
    }
  }

  // the class itself stays one chunk (unchanged shape vs. today); each concrete method/arrow
  // field additionally becomes its own precisely-addressable chunk with parentSymbol = the class
  private pushClassAndMethods(
    outer: SyntaxNode,
    classNode: SyntaxNode,
    input: ParserInput,
    lines: string[],
    imports: string[],
    out: RawChunk[],
  ): void {
    const nameNode = classNode.childForFieldName('name');
    const className = nameNode?.text ?? null;
    if (className) out.push(this.buildChunk(outer, 'class', className, null, input, lines, imports));

    const body = classNode.childForFieldName('body');
    if (!body || !className) return;

    for (const member of body.namedChildren) {
      if (member.type === 'method_definition') {
        const memberName = member.childForFieldName('name');
        if (memberName) out.push(this.buildChunk(member, 'method', memberName.text, className, input, lines, imports));
      } else if (member.type === 'public_field_definition') {
        const memberName = member.childForFieldName('name');
        const value = member.childForFieldName('value');
        if (!memberName || !value) continue;
        if (value.type !== 'arrow_function' && value.type !== 'function_expression') continue;
        out.push(this.buildChunk(member, 'method', memberName.text, className, input, lines, imports));
      }
    }
  }

  private buildChunk(
    node: SyntaxNode,
    kind: ChunkKind,
    symbol: string,
    parentSymbol: string | null,
    input: ParserInput,
    lines: string[],
    imports: string[],
  ): RawChunk {
    const declStartLine = node.startPosition.row + 1;
    const endLine = node.endPosition.row + 1;
    const startLine = expandToLeadingComments(lines, declStartLine, 'cstyle');
    return {
      path: input.path,
      area: input.area,
      language: input.language,
      kind,
      symbol,
      parentSymbol,
      startLine,
      endLine,
      content: lines.slice(startLine - 1, endLine).join('\n'),
      imports,
    };
  }

  // module-specifier only, matching the regex chunker's IMPORT_RE contract (chunkers/typescript.ts)
  private collectImports(root: SyntaxNode): string[] {
    const out: string[] = [];
    for (const child of root.namedChildren) {
      if (child.type !== 'import_statement') continue;
      const source = child.childForFieldName('source');
      if (!source) continue;
      const text = source.text;
      if (text.length >= 2) out.push(text.slice(1, -1));
    }
    return out;
  }
}
