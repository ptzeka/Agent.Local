# agent-local Postgres image: postgres + pgvector with our config baked in, so auth/server policy is
# versioned with the repo instead of living in the mounted data volume. pgvector is required by
# @agent-local/vectorstore (PgVectorStore.ensureSchema runs CREATE EXTENSION vector). Started via
# `-c config_file=...` (compose). Debian-based (the pgvector image has no alpine tag).
FROM pgvector/pgvector:pg18

# Config is read by the server at startup; COPY lands these as root-owned 0644, which the postgres user
# can read (config files have no strict-permission requirement, unlike the 0700 data directory).
COPY config/postgresql.conf /etc/postgresql/postgresql.conf
COPY config/pg_hba.conf     /etc/postgresql/pg_hba.conf
