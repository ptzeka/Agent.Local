// guards query-driven recall against degenerate one-token queries: a lone word (or punctuation)
// embeds to noise and returns misleading top-k matches, so we skip the lookup entirely below the floor
const MIN_QUERY_WORDS = 2;

// a "real word" is a run that contains a letter — bare digits/punctuation don't count toward the floor
function countWords(query: string): number {
  const matches = query.match(/\p{L}[\p{L}\p{N}'-]*/gu);
  return matches ? matches.length : 0;
}

export function isQueryTooShort(query: string): boolean {
  return countWords(query) < MIN_QUERY_WORDS;
}

// mirrors formatRecall's header+note shape so a caller parses a skipped recall like an empty one
export function queryTooShortNotice(collection: string): string {
  return (
    `collection: ${collection} · core: 0 · archival: 0\n` +
    `(query too short: need at least ${MIN_QUERY_WORDS} words — recall skipped)`
  );
}
