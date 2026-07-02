import Parser from 'tree-sitter';
import TS_GRAMMARS from 'tree-sitter-typescript';
import JS_LANG from 'tree-sitter-javascript';

// Node's ESM loader can't see this CJS package's named exports — destructure the default
const TS_LANG = TS_GRAMMARS.typescript;
const TSX_LANG = TS_GRAMMARS.tsx;
import type { ChunkKind, CodeEdge, RawChunk } from '../../types.js';
import { expandToLeadingComments } from '../chunkers/comments.js';
import { fillFileGaps } from '../chunkers/gaps.js';
import { importTargetId, symbolId } from './entityIds.js';
import type { IParser, ParseResult, ParserInput } from './types.js';

type SyntaxNode = Parser.SyntaxNode;

const TOP_LEVEL_KIND: Record<string, ChunkKind> = {
  function_declaration: 'function',
  interface_declaration: 'interface',
};

// per-file parsing state, so chunk builders don't each re-split content or re-scan imports.
// `edges` is the file's relationship collector — builders append, parse() dedupes once
interface SourceFile {
  input: ParserInput;
  lines: string[];
  imports: string[];
  importBindings: Map<string, string>;
  topLevelNames: Set<string>;
  edges: CodeEdge[];
}

// exists because the regex chunker is blind below the top level: here class methods become
// their own addressable symbols and relationships become edges; the injected fallback
// keeps unparseable files indexed
export class TreeLineParser implements IParser {
  private readonly parser = new Parser();

  constructor(private readonly fallback: IParser) {}

  parse(input: ParserInput): ParseResult {
    try {
      return this.parseWithTree(input);
    } catch {
      return this.fallback.parse(input);
    }
  }

  private parseWithTree(input: ParserInput): ParseResult {
    this.parser.setLanguage(this.grammarFor(input.language));
    const tree = this.parser.parse(input.content);
    const file = this.newSourceFile(input, tree.rootNode);

    const symbolChunks = tree.rootNode.namedChildren.flatMap(node => this.topLevelChunks(node, file));
    if (symbolChunks.length === 0) {
      return this.fallback.parse(input);
    }
    const chunks = fillFileGaps(symbolChunks, file.lines, {
      path: input.path,
      area: input.area,
      language: input.language,
      imports: file.imports,
    });
    return { chunks, edges: dedupeEdges(file.edges) };
  }

  private newSourceFile(input: ParserInput, root: SyntaxNode): SourceFile {
    const file: SourceFile = {
      input,
      lines: input.content.split(/\r?\n/),
      imports: [],
      importBindings: new Map(),
      topLevelNames: this.topLevelSymbolNames(root),
      edges: [],
    };
    for (const node of root.namedChildren) {
      if (node.type === 'import_statement') this.registerImport(node, file);
    }
    return file;
  }

  // names must be known before any edge resolves, so callees/heritage seen earlier
  // in the file than their definition still link
  private topLevelSymbolNames(root: SyntaxNode): Set<string> {
    const names = new Set<string>();
    for (const node of root.namedChildren) {
      const declaration = this.unwrapExport(node);
      const name = declaration.childForFieldName('name');
      if (name) names.add(name.text);
      if (declaration.type === 'lexical_declaration') {
        for (const declarator of declaration.namedChildren) {
          const declaratorName = declarator.childForFieldName('name');
          if (declaratorName) names.add(declaratorName.text);
        }
      }
    }
    return names;
  }

  private registerImport(importNode: SyntaxNode, file: SourceFile): void {
    const source = importNode.childForFieldName('source');
    if (!source) return;
    const specifier = this.unquoted(source.text);
    file.imports.push(specifier);

    const moduleId = importTargetId(file.input.path, specifier, file.input.language);
    const line = importNode.startPosition.row + 1;
    const bindings = this.importBindingsOf(importNode, moduleId);

    if (bindings.length === 0) {
      file.edges.push({ from: file.input.path, to: moduleId, type: 'imports', line });
      return;
    }
    for (const [local, targetId] of bindings) {
      file.importBindings.set(local, targetId);
      file.edges.push({ from: file.input.path, to: targetId, type: 'imports', line });
    }
  }

  private importBindingsOf(importNode: SyntaxNode, moduleId: string): Array<[string, string]> {
    const clause = importNode.namedChildren.find(child => child.type === 'import_clause');
    if (!clause) return [];

    return clause.namedChildren.flatMap((binding): Array<[string, string]> => {
      if (binding.type === 'identifier') {
        return [[binding.text, `${moduleId}#default`]];
      }
      if (binding.type === 'namespace_import') {
        const alias = binding.namedChildren.find(child => child.type === 'identifier');
        return alias ? [[alias.text, moduleId]] : [];
      }
      if (binding.type === 'named_imports') {
        return binding.namedChildren.flatMap((specifier): Array<[string, string]> => {
          if (specifier.type !== 'import_specifier') return [];
          const imported = specifier.childForFieldName('name');
          if (!imported) return [];
          const local = specifier.childForFieldName('alias') ?? imported;
          return [[local.text, `${moduleId}#${imported.text}`]];
        });
      }
      return [];
    });
  }

  private grammarFor(language: string): Parser.Language {
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

  private topLevelChunks(node: SyntaxNode, file: SourceFile): RawChunk[] {
    // spans use `node`, not the unwrapped declaration, so the `export` keyword stays in the chunk
    const declaration = this.unwrapExport(node);

    if (declaration.type === 'class_declaration' || declaration.type === 'abstract_class_declaration') {
      return this.classChunks(node, declaration, file);
    }

    const kind = TOP_LEVEL_KIND[declaration.type];
    if (kind) {
      const name = declaration.childForFieldName('name');
      if (!name) return [];
      if (kind === 'function') {
        this.collectCallEdges(declaration, symbolId(file.input.path, name.text), null, file);
      }
      return [this.chunkFor(node, kind, name.text, null, file)];
    }

    if (declaration.type === 'lexical_declaration') {
      return this.functionConstChunks(node, declaration, file);
    }
    return [];
  }

  private unwrapExport(node: SyntaxNode): SyntaxNode {
    if (node.type !== 'export_statement') return node;
    return node.childForFieldName('declaration') ?? node;
  }

  // the class stays one whole chunk and each method repeats inside it — accepted duplication,
  // so both "the class" and "just this method" are retrievable on their own
  private classChunks(exportNode: SyntaxNode, classNode: SyntaxNode, file: SourceFile): RawChunk[] {
    const className = classNode.childForFieldName('name')?.text;
    if (!className) return [];

    this.collectHeritageEdges(classNode, className, file);
    const wholeClass = this.chunkFor(exportNode, 'class', className, null, file);
    const body = classNode.childForFieldName('body');
    if (!body) return [wholeClass];

    const methods = body.namedChildren.flatMap(member => this.methodChunk(member, className, file));
    return [wholeClass, ...methods];
  }

  private collectHeritageEdges(classNode: SyntaxNode, className: string, file: SourceFile): void {
    const heritage = classNode.namedChildren.find(child => child.type === 'class_heritage');
    if (!heritage) return;

    const from = symbolId(file.input.path, className);
    for (const clause of heritage.namedChildren) {
      const type = clause.type === 'implements_clause' ? 'implements'
        : clause.type === 'extends_clause' ? 'extends'
        : null;
      if (!type) continue;
      for (const parentName of this.heritageNames(clause)) {
        file.edges.push({
          from,
          to: this.resolveTypeName(parentName, file),
          type,
          line: clause.startPosition.row + 1,
        });
      }
    }
  }

  private heritageNames(clause: SyntaxNode): string[] {
    return clause.namedChildren.flatMap(node => {
      if (node.type === 'identifier' || node.type === 'type_identifier') return [node.text];
      if (node.type === 'generic_type') {
        const name = node.childForFieldName('name');
        return name ? [name.text] : [];
      }
      return [];
    });
  }

  private methodChunk(member: SyntaxNode, className: string, file: SourceFile): RawChunk[] {
    const isMethod =
      member.type === 'method_definition' ||
      (member.type === 'public_field_definition' && this.isFunctionValued(member));
    const name = member.childForFieldName('name');
    if (!isMethod || !name) return [];
    this.collectCallEdges(member, symbolId(file.input.path, name.text, className), className, file);
    return [this.chunkFor(member, 'method', name.text, className, file)];
  }

  private functionConstChunks(exportNode: SyntaxNode, declaration: SyntaxNode, file: SourceFile): RawChunk[] {
    return declaration.namedChildren
      .filter(declarator => declarator.type === 'variable_declarator' && this.isFunctionValued(declarator))
      .flatMap(declarator => {
        const name = declarator.childForFieldName('name');
        if (!name) return [];
        this.collectCallEdges(declarator, symbolId(file.input.path, name.text), null, file);
        const isTsxComponent =
          (file.input.language === 'tsx' || file.input.language === 'jsx') && /^[A-Z]/.test(name.text);
        return [this.chunkFor(exportNode, isTsxComponent ? 'component' : 'function', name.text, null, file)];
      });
  }

  // only calls that resolve — same-file symbols, imported bindings, this.<method> —
  // become edges; builtins and local variables would be graph noise
  private collectCallEdges(node: SyntaxNode, fromId: string, thisClass: string | null, file: SourceFile): void {
    const target = this.callTargetOf(node, thisClass, file);
    if (target) {
      file.edges.push({ from: fromId, to: target, type: 'calls', line: node.startPosition.row + 1 });
    }
    for (const child of node.namedChildren) {
      this.collectCallEdges(child, fromId, thisClass, file);
    }
  }

  private callTargetOf(node: SyntaxNode, thisClass: string | null, file: SourceFile): string | null {
    if (node.type === 'call_expression') {
      const callee = node.childForFieldName('function');
      if (callee?.type === 'identifier') return this.resolveCallableName(callee.text, file);
      if (callee?.type === 'member_expression') {
        const object = callee.childForFieldName('object');
        const property = callee.childForFieldName('property');
        if (object?.type === 'this' && property && thisClass) {
          return symbolId(file.input.path, property.text, thisClass);
        }
      }
      return null;
    }
    if (node.type === 'new_expression') {
      const constructor = node.childForFieldName('constructor');
      if (constructor?.type === 'identifier') return this.resolveCallableName(constructor.text, file);
    }
    return null;
  }

  private resolveCallableName(name: string, file: SourceFile): string | null {
    if (file.topLevelNames.has(name)) return symbolId(file.input.path, name);
    return file.importBindings.get(name) ?? null;
  }

  private resolveTypeName(name: string, file: SourceFile): string {
    if (file.topLevelNames.has(name)) return symbolId(file.input.path, name);
    return file.importBindings.get(name) ?? `unresolved:${name}`;
  }

  private isFunctionValued(node: SyntaxNode): boolean {
    const value = node.childForFieldName('value');
    return value?.type === 'arrow_function' || value?.type === 'function_expression';
  }

  private chunkFor(
    node: SyntaxNode,
    kind: ChunkKind,
    symbol: string,
    parentSymbol: string | null,
    file: SourceFile,
  ): RawChunk {
    const declarationLine = node.startPosition.row + 1;
    const endLine = node.endPosition.row + 1;
    const startLine = expandToLeadingComments(file.lines, declarationLine, 'cstyle');
    return {
      path: file.input.path,
      area: file.input.area,
      language: file.input.language,
      kind,
      symbol,
      parentSymbol,
      startLine,
      endLine,
      content: file.lines.slice(startLine - 1, endLine).join('\n'),
      imports: file.imports,
    };
  }

  private unquoted(stringLiteral: string): string {
    return stringLiteral.length >= 2 ? stringLiteral.slice(1, -1) : stringLiteral;
  }
}

// a call site repeated in a loop or a re-imported name should not multiply edges:
// first occurrence wins, its line becomes the edge's anchor
function dedupeEdges(edges: CodeEdge[]): CodeEdge[] {
  const seen = new Set<string>();
  return edges.filter(edge => {
    const key = `${edge.from}|${edge.type}|${edge.to}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
