-- Run against the `postgres` maintenance db. Creates the target database if missing — Postgres has no
-- CREATE DATABASE IF NOT EXISTS, so \gexec runs a generated CREATE only when the catalog check finds
-- none. Idempotent. dbname is passed by the runner via `psql -v dbname=...`. The compose stack already
-- creates POSTGRES_DB, so this is usually a no-op; it keeps provisioning self-contained.
SELECT format('CREATE DATABASE %I', :'dbname')
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = :'dbname')\gexec
