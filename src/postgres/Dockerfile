# agent-local Postgres image: stock postgres with our config baked in, so auth/server policy is versioned
# with the repo instead of living in the mounted data volume. Started via `-c config_file=...` (compose).
FROM postgres:16-alpine

# Config is read by the server at startup; COPY lands these as root-owned 0644, which the postgres user
# can read (config files have no strict-permission requirement, unlike the 0700 data directory).
COPY config/postgresql.conf /etc/postgresql/postgresql.conf
COPY config/pg_hba.conf     /etc/postgresql/pg_hba.conf
