# Postgres infrastructure — provisioning

Idempotent provisioning for the `agentlocal` database: roles/users, schemas, and every app table.
Run **after** the stack is up (`npm start` in `src/postgres`):

```bash
npm run db:provision   # from src/postgres
```

Re-runnable: every step is guarded or `IF NOT EXISTS`, so applying it twice is a no-op. It connects as
the superuser the compose stack creates (`POSTGRES_USER` / `POSTGRES_PASSWORD`, default `agent`/`agent`).

## What it creates

### Roles & users (`bootstrap/01_roles.sql`)
Two NOLOGIN **group** roles bundle privilege; login users are granted into a group and never carry
privileges directly. `app_readwrite` inherits `app_readonly` (a writer can also read).

| Login user | Group | Used by |
|---|---|---|
| `codemcp_ro` | `app_readonly` | the read-path code search MCP server — **structurally cannot write** |
| `codeindex_rw` | `app_readwrite` | the codeindex indexer (writes commits + vectors) |
| `memomcp_rw` | `app_readwrite` | the memo MCP server (remember + recall) |

> **DEV passwords** equal the role name (`codemcp_ro` / `codeindex_rw` / `memomcp_rw`). Override before
> any shared use. The read-only/read-write split mirrors the agent's structural tool privilege model.

### Schemas (`bootstrap/02_schemas.sql`)
`code` and `memo`, owned by `agent`. Default privileges are scoped `FOR ROLE agent`, so any table dbup
later creates in these schemas is auto-granted to the two groups. `bootstrap/03_grants.sql` then grants
on the tables that already exist (default privileges only cover *future* objects).

### Tables (`migration/` — the dbup engine)
Declarative, idempotent reconcile — the pg counterpart of `common/src/db.ts`. Each table is its own spec
module under `migration/tables/`; `migration/schema.ts` composes them. Drift is **additive**
(`ADD COLUMN IF NOT EXISTS`): pg can ALTER in place, so a redesign adds columns/indexes without dropping
data. To add a table, write a module and list it in `schema.ts`.

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
- `@agent-local/vectorstore` `PgVectorStore.ensureSchema` still issues `CREATE TABLE … VECTOR` (unpinned,
  public schema). It must target `code`/`memo` schemas and stop creating its own table so the pinned,
  indexed tables here win.
- codeindex's forward-only `MigrationRunner` (`commits` / `schema_versions`) overlaps `code.commits` —
  decide whether to retire it.
