// the SQL connection abstraction now lives once in @agent-local/vectorstore;
// codeindex re-exports it so its own modules (FileConnection, migrate, repos) keep one import path
export type { DbConnection, DbConnectionFactory, QueryResult } from '@agent-local/vectorstore';
