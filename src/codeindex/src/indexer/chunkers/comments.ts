// Pulls a declaration's leading doc comment (the contiguous block directly above it, no blank line)
// into its chunk, so the embedder sees intent and the assistant can cite docs with the code.
// startLine shifts up to the first comment line; endLine is unchanged.

export type CommentSyntax = 'cstyle' | 'sql';

interface SyntaxRules {
  // line-comment prefixes (any match counts)
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

// walks back from declStartLine (1-based) over contiguous comment lines, stopping at the first
// blank or non-comment line; returns the new (earlier-or-equal) 1-based start line
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
      // walk back to the matching block start, which may be on this same line or earlier
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

// strips leading comment lines so the SQL chunker's symbol regexes match the underlying keyword;
// only the text passed to the detector is stripped, not the stored chunk content
export function stripLeadingComments(text: string, syntax: CommentSyntax): string {
  const rules = syntax === 'sql' ? SQL_STYLE : C_STYLE;
  const lines = text.split(/\r?\n/);
  let firstCode = 0;

  while (firstCode < lines.length) {
    const trimmed = (lines[firstCode] ?? '').trim();
    if (trimmed.length === 0) { firstCode++; continue; }
    if (rules.lineStarts.some(p => trimmed.startsWith(p))) { firstCode++; continue; }
    if (trimmed.startsWith(rules.blockStart)) {
      // skip lines until the block closes
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
