# Postgres infrastructure — provisioning

Idempotent provisioning for the `agentlocal` database: roles/users, schemas, and every app table — all
plain SQL applied by [`provision.sh`](./provision.sh) via `psql` inside the running container. Run
**after** the stack is up (`npm start` in `src/postgres`):

```bash
npm run db:provision   # from src/postgres
```

Re-runnable: every script is guarded or `CREATE ... IF NOT EXISTS`, so applying it twice is a no-op.
`provision.sh` execs `psql` in the container (local socket = `trust` per `pg_hba.conf`, so no password).

## The scripts (applied in order)

| File | Target db | What |
|---|---|---|
| `sql/00_databases.sql` | `postgres` | create `agentlocal` if missing (`\gexec` guard; compose usually made it) |
| `sql/01_roles.sql` | `agentlocal` | group roles + login users + group grants |
| `sql/02_schemas.sql` | `agentlocal` | `code` / `memo` schemas + default privileges for future tables |
| `sql/03_tables.sql` | `agentlocal` | extension `vector`, tables + hnsw/gin indexes |
| `sql/04_grants.sql` | `agentlocal` | grants on the tables that now exist |

Adding/changing schema = edit the relevant `sql/*.sql` (keep it `IF NOT EXISTS`) and re-run
`db:provision`. Postgres can't `ADD COLUMN` idempotently in one stock statement before PG16; on PG18
use `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`. For destructive changes (rename, type change, backfill)
write a one-off statement and apply it deliberately — `IF NOT EXISTS` scripts only move forward additively.

## Roles & users

Two NOLOGIN **group** roles bundle privilege; login users are granted into a group and never carry
privileges directly. `app_readwrite` inherits `app_readonly` (a writer can also read).

| Login user | Group | Used by |
|---|---|---|
| `codemcp_ro` | `app_readonly` | the read-path code search MCP server — **structurally cannot write** |
| `codeindex_rw` | `app_readwrite` | the codeindex indexer (writes commits + vectors) |
| `memomcp_rw` | `app_readwrite` | the memo MCP server (remember + recall) |

> **DEV passwords** equal the role name. Override before any shared use. The read-only/read-write split
> mirrors the agent's structural tool privilege model.

## Tables

| Table | Notes |
|---|---|
| `code.commits` | codeindex snapshot bookkeeping |
| `code.vector_records` | `VECTOR(768)` (codemcp local embeds) + hnsw + gin |
| `memo.vector_records` | `VECTOR(1024)` (memomcp voyage embeds) + hnsw + gin |

**Why two vector tables, not one:** an unpinned `VECTOR` column cannot carry an hnsw index. Pinning the
dimension per schema makes each store exactly-and-indexably searchable; the dimensions match each
consumer's embed provider.

## Not yet wired (consumer reconciliation — separate task)

The provisioner is authoritative, but the consumers still point elsewhere:

- codemcp/memomcp/codeindex default DSNs name `codeindex`/`memomcp` databases and `CHANGE_ME` passwords —
  repoint them at `agentlocal` with the matching login user.
- codeindex's forward-only `MigrationRunner` (`commits` / `schema_versions`) overlaps `code.commits` —
  decide whether to retire it.

`@agent-local/vectorstore`'s `PgVectorStore` now *accepts* a schema-qualified `table` option (e.g.
`{ table: "code.vector_records" }`), so a consumer can target these pinned, indexed tables instead of
issuing its own unpinned `public.vector_records` — but no consumer passes that option yet, so
`ensureSchema()` still falls back to creating the unpinned public table when the provisioner hasn't run.
