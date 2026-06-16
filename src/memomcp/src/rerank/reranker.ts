// reranking reorders recall candidates by relevance to the query — a second pass after cosine retrieval.
// the vectorstore stays agnostic (cosine + equality only), so this lives in the memomcp layer,
// hidden behind an interface so the backend (local stand-in now, a cross-encoder/hosted model later) swaps freely.

export interface RerankItem {
  // stable handle the caller maps back to its record (a memory's vectorId)
  id: string;
  // the text scored against the query
  text: string;
}

export interface RerankScore {
  id: string;
  // higher = more relevant; the order is what the caller consumes, the value is diagnostic
  score: number;
}

export interface IReranker {
  // returns the items scored against the query, best-first; ids not in the input are never invented
  rank(query: string, items: RerankItem[]): Promise<RerankScore[]>;
}
