// shared TS/JS source fixtures so RegexParser/TreeLineParser tests assert parity off the same input

export const FUNCTION_SRC = `export function add(a: number, b: number): number {
  return a + b;
}
`;

export const CLASS_SRC = `export class Greeter {
  constructor(private name: string) {}

  greet(): string {
    return \`hello \${this.name}\`;
  }

  static create(name: string): Greeter {
    return new Greeter(name);
  }
}
`;

export const ARROW_CONST_SRC = `export const multiply = (a, b) => {
  return a * b;
};
`;

// RegexParser's arrow-function pattern requires \`=>\` immediately after the parameter list —
// an explicit return-type annotation between \`)\` and \`=>\` isn't matched. TreeLineParser
// detects this correctly via the AST; used only in treeLineParser.test.ts to document the win.
export const ARROW_CONST_WITH_RETURN_TYPE_SRC = `export const divide = (a: number, b: number): number => {
  return a / b;
};
`;

export const TSX_COMPONENT_SRC = `export const Widget = () => {
  return <div>hi</div>;
};
`;

export const INTERFACE_SRC = `export interface Shape {
  area(): number;
}
`;

export const IMPORTS_SRC = `import { Foo, Bar as Baz } from './foo';
import Default from './bar';

export function useThem(): void {
  Foo();
}
`;

export const NO_SYMBOLS_SRC = `export const x = 5;
`;
