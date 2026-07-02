export type EdgeType = 'imports' | 'calls' | 'implements' | 'extends';

// mirrors codeindex's CodeEdge (types.ts) — the writer/reader contract for edges.jsonl.
// Endpoints are entity ids: `<path>`, `<path>#Symbol`, `<path>#Class.method`,
// `external:<module>`, `unresolved:<name>`
export interface EdgeRow {
  from: string;
  to: string;
  type: EdgeType;
  line: number;
}

export interface IEdgeRepository {
  listEdges(commitSha: string): Promise<EdgeRow[]>;
}
