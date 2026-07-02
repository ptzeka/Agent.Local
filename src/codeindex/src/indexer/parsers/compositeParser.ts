import type { IParser, ParseResult, ParserInput } from './types.js';

// dispatches to the AST-capable parser for a file's language family; each family fails
// independently into its own fallback, so a bug in one language's grammar can't blank another's
export class CompositeParser implements IParser {
  constructor(
    private readonly jsLike: IParser,
    private readonly csharp: IParser,
  ) {}

  parse(input: ParserInput): ParseResult {
    if (input.language === 'csharp') return this.csharp.parse(input);
    return this.jsLike.parse(input);
  }
}
