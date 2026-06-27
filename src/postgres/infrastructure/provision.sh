#!/usr/bin/env bash
# Idempotent provisioner for the agentlocal Postgres: applies the ordered sql/ files via psql inside the
# running container (local socket = trust per pg_hba.conf, so no password). Re-runnable — every script is
# guarded or CREATE ... IF NOT EXISTS. Requires the stack to be up (src/postgres: npm start).
#
# 00 runs on the `postgres` maintenance db (it may create the target db); the rest run on the target db.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SQL_DIR="$ROOT/sql"

CONTAINER="${POSTGRES_CONTAINER:-agent-local-postgres}"
DB="${POSTGRES_DB:-agentlocal}"
DB_USER="${POSTGRES_USER:-agent}"

if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "[provision] container '$CONTAINER' not found — start the stack first (src/postgres: npm start)" >&2
  exit 1
fi

# $1 = target db, $2 = sql file, plus any extra psql args
apply() {
  local target="$1" file="$2"; shift 2
  echo "[provision] applying $(basename "$file") -> $target"
  docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$target" "$@" < "$file"
}

apply postgres "$SQL_DIR/00_databases.sql" -v "dbname=$DB"
apply "$DB" "$SQL_DIR/01_roles.sql"
apply "$DB" "$SQL_DIR/02_schemas.sql"
apply "$DB" "$SQL_DIR/03_tables.sql"
apply "$DB" "$SQL_DIR/04_grants.sql"

echo "[provision] done"
