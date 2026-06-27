// Postgres dbup — declarative, idempotent schema reconcile, the pg counterpart of common/src/db.ts.
// Each table is its own spec module (migration/tables/*); schema.ts composes them. Unlike the SQLite
// engine, drift is handled additively (ADD COLUMN IF NOT EXISTS) — pg can ALTER in place, so a redesign
// adds columns/indexes without dropping data. Run-once or re-run: a second pass is a no-op.

export interface SqlRunner {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

export interface PgColumnSpec {
  name: string;
  // raw pg type, e.g. "TEXT", "VECTOR(768)", "TIMESTAMPTZ"
  type: string;
  // trailing column constraints, e.g. "NOT NULL", "NOT NULL DEFAULT now()"
  constraints?: string;
}

export interface PgIndexSpec {
  name: string;
  // access method; omit/btree for a plain index, "hnsw"/"gin"/"ivfflat" for the others
  using?: "btree" | "hnsw" | "gin" | "ivfflat";
  // raw column/opclass list authored in the spec (not user input), e.g. "embedding vector_cosine_ops"
  columns: string;
  unique?: boolean;
  where?: string;
}

export interface PgTableSpec {
  schema: string;
  name: string;
  columns: PgColumnSpec[];
  primaryKey?: string[];
  indexes?: PgIndexSpec[];
}

export interface PgSchemaSpec {
  // extensions ensured before any table (e.g. "vector" for the VECTOR column type)
  extensions?: string[];
  // declared parent-before-child so an FK target always precedes its referent
  tables: PgTableSpec[];
}

export interface DbupLogger {
  info?: (message: string) => void;
}

// brings `db` up to `spec`: extensions, then tables (create + additive column adds), then indexes.
export async function ensureSchema(db: SqlRunner, spec: PgSchemaSpec, logger: DbupLogger = {}): Promise<void> {
  for (const ext of spec.extensions ?? []) {
    await db.query(`CREATE EXTENSION IF NOT EXISTS ${ident(ext)}`);
  }
  for (const table of spec.tables) await ensureTable(db, table, logger);
  for (const table of spec.tables) await ensureIndexes(db, table, logger);
}

async function ensureTable(db: SqlRunner, table: PgTableSpec, logger: DbupLogger): Promise<void> {
  const qualified = `${ident(table.schema)}.${ident(table.name)}`;
  const lines = table.columns.map(renderColumn);
  if (table.primaryKey?.length) {
    lines.push(`PRIMARY KEY (${table.primaryKey.map(ident).join(", ")})`);
  }
  await db.query(`CREATE TABLE IF NOT EXISTS ${qualified} (${lines.join(", ")})`);
  // additive evolution: a column added to the spec after first run is created in place. existing
  // columns are skipped by IF NOT EXISTS. a NEW non-null column needs a default to apply to live rows.
  for (const column of table.columns) {
    await db.query(`ALTER TABLE ${qualified} ADD COLUMN IF NOT EXISTS ${renderColumn(column)}`);
  }
  logger.info?.(`[dbup] ensured table ${qualified}`);
}

async function ensureIndexes(db: SqlRunner, table: PgTableSpec, logger: DbupLogger): Promise<void> {
  for (const index of table.indexes ?? []) {
    const unique = index.unique ? "UNIQUE " : "";
    const using = index.using && index.using !== "btree" ? ` USING ${index.using}` : "";
    const where = index.where ? ` WHERE ${index.where}` : "";
    await db.query(
      `CREATE ${unique}INDEX IF NOT EXISTS ${ident(index.name)} ` +
        `ON ${ident(table.schema)}.${ident(table.name)}${using} (${index.columns})${where}`,
    );
    logger.info?.(`[dbup] ensured index ${index.name}`);
  }
}

function renderColumn(column: PgColumnSpec): string {
  const constraints = column.constraints ? ` ${column.constraints}` : "";
  return `${ident(column.name)} ${column.type}${constraints}`;
}

// identifiers (schema/table/column/index names) are interpolated into DDL, so they must be bare —
// reject anything that could inject. opclass/column expressions in IndexSpec.columns are spec-authored.
function ident(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Invalid SQL identifier: ${name}`);
  }
  return name;
}
