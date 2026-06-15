// the single home for the SQL connection abstraction — codeindex/codemcp dedupe their
// byte-identical db/types.ts onto this when they move to the engine
export interface QueryResult<T = unknown> {
  rows: T[];
  rowCount: number;
}

export interface DbConnection extends AsyncDisposable {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  begin(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface DbConnectionFactory {
  getConnection(): Promise<DbConnection>;
  withTransaction<T>(fn: (conn: DbConnection) => Promise<T>): Promise<T>;
  end(): Promise<void>;
}
