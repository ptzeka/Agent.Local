import Parser from 'tree-sitter';
import CSHARP_LANG from 'tree-sitter-c-sharp';
import type { ChunkKind, CodeEdge, RawChunk } from '../../types.js';
import { expandToLeadingComments } from '../chunkers/comments.js';
import { fillFileGaps } from '../chunkers/gaps.js';
import { importTargetId, symbolId } from './entityIds.js';
import type { IParser, ParseResult, ParserInput } from './types.js';

type SyntaxNode = Parser.SyntaxNode;

const TYPE_DECL_KIND: Record<string, ChunkKind> = {
  class_declaration: 'class',
  struct_declaration: 'class',
  record_declaration: 'record',
  interface_declaration: 'interface',
};

const METHOD_LIKE = new Set(['method_declaration', 'constructor_declaration', 'local_function_statement']);

// per-file parsing state, mirroring TreeLineParser's SourceFile: `edges` is the collector,
// builders append, parse() dedupes once
interface SourceFile {
  input: ParserInput;
  lines: string[];
  imports: string[];
  topLevelNames: Set<string>;
  edges: CodeEdge[];
}

// gives C# the same AST-backed symbol/relationship granularity TreeLineParser gives TS/JS;
// the heuristic brace-block chunker (chunkCSharp) becomes purely this parser's failure fallback.
// C# has no `extends`/`implements` keywords — a base_list entry is disambiguated by the
// `I<Upper>` interface-naming convention (see collectHeritageEdges), a heuristic, not a fact.
export class CSharpTreeParser implements IParser {
  private readonly parser = new Parser();

  constructor(private readonly fallback: IParser) {
    this.parser.setLanguage(CSHARP_LANG as unknown as Parser.Language);
  }

  parse(input: ParserInput): ParseResult {
    try {
      return this.parseWithTree(input);
    } catch {
      return this.fallback.parse(input);
    }
  }

  private parseWithTree(input: ParserInput): ParseResult {
    const tree = this.parser.parse(input.content);
    const file = this.newSourceFile(input, tree.rootNode);
    const declarations = this.flattenDeclarations(tree.rootNode);
    const symbolChunks = declarations.flatMap(node => this.typeChunks(node, file));
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

  // block-scoped `namespace X { ... }` nests declarations one level deeper than file-scoped
  // `namespace X;`; unwrap block namespaces (recursively, for nested namespaces) so both forms
  // yield the same flat list of type declarations
  private flattenDeclarations(node: SyntaxNode): SyntaxNode[] {
    return node.namedChildren.flatMap(child => {
      if (child.type === 'namespace_declaration') {
        const body = child.childForFieldName('body');
        return body ? this.flattenDeclarations(body) : [];
      }
      return [child];
    });
  }

  // names must be known before any edge resolves, so a base-list/call seen earlier in the
  // file than its definition still links (mirrors TreeLineParser.topLevelSymbolNames)
  private newSourceFile(input: ParserInput, root: SyntaxNode): SourceFile {
    const declarations = this.flattenDeclarations(root);
    const topLevelNames = new Set<string>();
    for (const decl of declarations) {
      const name = decl.childForFieldName('name')?.text;
      if (name) topLevelNames.add(name);
    }
    const file: SourceFile = { input, lines: input.content.split(/\r?\n/), imports: [], topLevelNames, edges: [] };
    this.collectUsings(root, file);
    return file;
  }

  // usings can precede a block namespace or live just inside one; file-scoped namespaces
  // never nest usings further, so one level of namespace descent covers both forms
  private collectUsings(root: SyntaxNode, file: SourceFile): void {
    for (const child of root.namedChildren) {
      if (child.type === 'using_directive') {
        this.registerUsing(child, file);
      } else if (child.type === 'namespace_declaration') {
        const body = child.childForFieldName('body');
        if (body) this.collectUsings(body, file);
      }
    }
  }

  private registerUsing(node: SyntaxNode, file: SourceFile): void {
    // the grammar types `using_directive`'s payload as an unnamed `type` child, not a `name`
    // field (that field only covers the alias in `using X = Y;`) — take the first named child
    const target = node.namedChildren[0];
    if (!target) return;
    const specifier = target.text;
    file.imports.push(specifier);
    const moduleId = importTargetId(file.input.path, specifier, file.input.language);
    file.edges.push({ from: file.input.path, to: moduleId, type: 'imports', line: node.startPosition.row + 1 });
  }

  private typeChunks(node: SyntaxNode, file: SourceFile): RawChunk[] {
    const kind = TYPE_DECL_KIND[node.type];
    if (!kind) return [];
    const name = node.childForFieldName('name');
    if (!name) return [];

    this.collectHeritageEdges(node, name.text, file);
    const wholeType = this.chunkFor(node, kind, name.text, null, file);

    // interfaces stay one chunk (parity with TreeLineParser's interface handling): a member
    // is a bodyless signature, nothing worth retrieving as its own symbol
    if (node.type === 'interface_declaration') return [wholeType];

    const body = node.childForFieldName('body');
    if (!body) return [wholeType];

    // sibling method names must be known before any call resolves, so `Step()` called
    // bare (no `this.`) from another method of the same type still links — C# allows
    // omitting the receiver for same-type calls, unlike TS/JS's free-function model
    const memberNodes = body.namedChildren.filter(m => METHOD_LIKE.has(m.type));
    const siblingMethods = new Set<string>();
    for (const m of memberNodes) {
      const memberName = m.childForFieldName('name')?.text;
      if (memberName) siblingMethods.add(memberName);
    }

    const members = memberNodes.flatMap(member => this.memberChunk(member, name.text, siblingMethods, file));
    return [wholeType, ...members];
  }

  // C# doesn't syntactically distinguish a base class from an interface in a base_list — by
  // convention interfaces are named `I<Upper...>`; a leading non-interface-shaped entry is
  // the base class (at most one, and only ever first), everything else implements
  private collectHeritageEdges(typeNode: SyntaxNode, typeName: string, file: SourceFile): void {
    const baseList = typeNode.namedChildren.find(c => c.type === 'base_list');
    if (!baseList) return;
    const names = baseList.namedChildren.flatMap(n => this.heritageName(n));
    if (names.length === 0) return;

    const from = symbolId(file.input.path, typeName);
    names.forEach((name, i) => {
      const isInterfaceLike = /^I[A-Z]/.test(name);
      const type: 'extends' | 'implements' = i === 0 && !isInterfaceLike ? 'extends' : 'implements';
      file.edges.push({ from, to: this.resolveTypeName(name, file), type, line: baseList.startPosition.row + 1 });
    });
  }

  private heritageName(node: SyntaxNode): string[] {
    if (node.type === 'identifier') return [node.text];
    if (node.type === 'qualified_name') {
      const name = node.childForFieldName('name');
      return name ? [name.text] : [];
    }
    if (node.type === 'generic_name') {
      const first = node.namedChildren.find(c => c.type === 'identifier');
      return first ? [first.text] : [];
    }
    return [];
  }

  private memberChunk(member: SyntaxNode, typeName: string, siblingMethods: Set<string>, file: SourceFile): RawChunk[] {
    const name = member.childForFieldName('name');
    if (!name) return [];
    this.collectCallEdges(member, symbolId(file.input.path, name.text, typeName), typeName, siblingMethods, file);
    return [this.chunkFor(member, 'method', name.text, typeName, file)];
  }

  // only calls that resolve — a same-type method (bare or `this.`-qualified) and same-file
  // `new` targets — become edges; BCL/library calls and locals would be graph noise without
  // a real type checker
  private collectCallEdges(
    node: SyntaxNode,
    fromId: string,
    thisType: string | null,
    siblingMethods: Set<string>,
    file: SourceFile,
  ): void {
    const target = this.callTargetOf(node, thisType, siblingMethods, file);
    if (target) {
      file.edges.push({ from: fromId, to: target, type: 'calls', line: node.startPosition.row + 1 });
    }
    for (const child of node.namedChildren) {
      this.collectCallEdges(child, fromId, thisType, siblingMethods, file);
    }
  }

  private callTargetOf(
    node: SyntaxNode,
    thisType: string | null,
    siblingMethods: Set<string>,
    file: SourceFile,
  ): string | null {
    if (node.type === 'invocation_expression') {
      const callee = node.childForFieldName('function');
      if (!callee) return null;
      if (callee.type === 'identifier') {
        if (thisType && siblingMethods.has(callee.text)) return symbolId(file.input.path, callee.text, thisType);
        return null;
      }
      if (callee.type === 'member_access_expression') {
        const object = callee.childForFieldName('expression');
        const property = callee.childForFieldName('name');
        if (object?.type === 'this' && property && thisType) {
          return symbolId(file.input.path, property.text, thisType);
        }
      }
      return null;
    }
    if (node.type === 'object_creation_expression') {
      const typeNode = node.childForFieldName('type');
      const name = typeNode ? this.heritageName(typeNode)[0] : undefined;
      return name && file.topLevelNames.has(name) ? symbolId(file.input.path, name) : null;
    }
    return null;
  }

  private resolveTypeName(name: string, file: SourceFile): string {
    return file.topLevelNames.has(name) ? symbolId(file.input.path, name) : `unresolved:${name}`;
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
