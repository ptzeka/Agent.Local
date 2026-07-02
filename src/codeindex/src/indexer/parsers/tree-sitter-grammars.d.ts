// tree-sitter-typescript / tree-sitter-javascript ship no bundled type declarations
// and have no @types package on npm — minimal ambient shapes for what we call.
declare module 'tree-sitter-typescript' {
  import type Parser from 'tree-sitter';
  // Node's ESM loader misses this CJS package's named exports (ts-jest tolerates it, real
  // node does not) — import the default and destructure at runtime, see treeLineParser.ts
  interface TypeScriptGrammars {
    typescript: Parser.Language;
    tsx: Parser.Language;
  }
  const grammars: TypeScriptGrammars;
  export default grammars;
}

declare module 'tree-sitter-javascript' {
  import type Parser from 'tree-sitter';
  const language: Parser.Language;
  export default language;
}
