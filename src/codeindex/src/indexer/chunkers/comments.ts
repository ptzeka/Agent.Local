// Shared helper for pulling leading doc comments into a chunk.
//
// A declaration's "doc" comment is the comment block immediately above it,
// with no blank line separating them. Including it in the chunk means:
//   - the embedder sees the intent ("what this function is for"), not just the body
//   - the assistant can quote the docs alongside the code with line citations
// The chunk's startLine is shifted up to the first comment line; endLine is unchanged.

export type CommentSyntax = 'cstyle' | 'sql';

interface SyntaxRules {
  /** Line-comment prefixes (any match counts). */
  lineStarts: string[];
  blockStart: string;
  blockEnd: string;
}

const C_STYLE: SyntaxRules = {
  lineStarts: ['//'],   // covers `//`, `///`, `////`, etc. — all start with `//`
  blockStart: '/*',     // covers `/*` and `/**`
  blockEnd: '*/',
};

const SQL_STYLE: SyntaxRules = {
  lineStarts: ['--'],
  blockStart: '/*',
  blockEnd: '*/',
};

/**
 * Walks backward from `declStartLine` (1-based) collecting contiguous comment
 * lines. Stops at the first blank line or non-comment line. Returns the new
 * (earlier-or-equal) 1-based start line.
 */
export function expandToLeadingComments(
  lines: string[],
  declStartLine: number,
  syntax: CommentSyntax,
): number {
  const rules = syntax === 'sql' ? SQL_STYLE : C_STYLE;
  let earliest = declStartLine;
  let i = declStartLine - 2; // 0-based index of the line just above the declaration

  while (i >= 0) {
    const trimmed = (lines[i] ?? '').trim();

    if (trimmed.length === 0) break;

    if (rules.lineStarts.some(prefix => trimmed.startsWith(prefix))) {
      earliest = i + 1;
      i--;
      continue;
    }

    if (trimmed.endsWith(rules.blockEnd)) {
      // Walk back further to find the matching block start. Allow it to be
      // on the same line (single-line block comment) or any earlier line.
      let j = i;
      let foundStart = false;
      while (j >= 0) {
        const candidate = lines[j] ?? '';
        if (candidate.includes(rules.blockStart)) {
          earliest = j + 1;
          i = j - 1;
          foundStart = true;
          break;
        }
        j--;
      }
      if (!foundStart) break;
      continue;
    }

    break;
  }

  return earliest;
}

/**
 * Strip leading comment lines from a statement body — used by the SQL
 * chunker so symbol-extraction regexes can match the underlying DDL/DML
 * keyword. The original chunk content is left untouched; only the text
 * passed to the symbol detector is stripped.
 */
export function stripLeadingComments(text: string, syntax: CommentSyntax): string {
  const rules = syntax === 'sql' ? SQL_STYLE : C_STYLE;
  const lines = text.split(/\r?\n/);
  let firstCode = 0;

  while (firstCode < lines.length) {
    const trimmed = (lines[firstCode] ?? '').trim();
    if (trimmed.length === 0) { firstCode++; continue; }
    if (rules.lineStarts.some(p => trimmed.startsWith(p))) { firstCode++; continue; }
    if (trimmed.startsWith(rules.blockStart)) {
      // Skip lines until we close the block.
      while (firstCode < lines.length) {
        const line = lines[firstCode] ?? '';
        firstCode++;
        if (line.includes(rules.blockEnd)) break;
      }
      continue;
    }
    break;
  }

  return lines.slice(firstCode).join('\n');
}
