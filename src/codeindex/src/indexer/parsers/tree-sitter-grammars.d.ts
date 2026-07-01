// tree-sitter-typescript / tree-sitter-javascript ship no bundled type declarations
// and have no @types package on npm — minimal ambient shapes for what we call.
declare module 'tree-sitter-typescript' {
  import type Parser from 'tree-sitter';
  // Node's native ESM loader doesn't reliably surface this CJS package's named exports
  // (works under ts-jest's CJS transform, fails under `node --experimental-vm-modules`-style
  // real ESM) — import the default and destructure at runtime instead, see treeLineParser.ts
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
