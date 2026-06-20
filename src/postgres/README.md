# @agent-local/postgres

Standalone local **Postgres + pgAdmin** for ad-hoc querying. Deploy-only workspace — no Node/agent code.
It is **not** part of the app lifecycle (`npm start` at the repo root does not touch it); bring it up and
down with this workspace's own scripts.

The Postgres config (`postgresql.conf`, `pg_hba.conf`) is **baked into the image** at build time (see
[`Dockerfile`](./Dockerfile)), so auth/server policy is versioned with the repo, not stored in the data
volume.

## Requires a Docker runtime

Any OCI runtime with a `docker` CLI works — no Docker Desktop license needed:

- **Windows**: [Rancher Desktop](https://rancherdesktop.io) (`winget install suse.RancherDesktop`, WSL2 backend)
- **macOS**: [colima](https://github.com/abiosoft/colima) (`brew install colima && colima start`)

> `colima`/Lima do **not** run on Windows; use Rancher Desktop there.

## Usage

```bash
# from src/postgres
npm start            # build image (config baked in) + compose up + wait for health
npm stop             # compose down (data volume preserved)
npm stop -- --wipe   # compose down AND drop the data volume (all data lost)
npm run build        # (re)build the image after editing Dockerfile/config
npm run healthcheck  # pg_isready against the running container
npm run ssh          # open a shell (sh) inside the container
npm run psql         # open a psql shell inside the container
npm run logs         # tail container logs
```

## What you get

| Service  | URL / port              | Credentials                          |
| -------- | ----------------------- | ------------------------------------ |
| Postgres | `localhost:5432`        | user `agent` / pass `agent`, db `agentlocal` |
| pgAdmin  | http://localhost:5050   | `admin@agent.local` / `admin`        |

pgAdmin auto-registers the Postgres server on first boot (via [`config/servers.json`](./config/servers.json)),
so it appears under **Servers → agent-local** ready to query — enter the password `agent` once when prompted.

No schema is created on load — the `agentlocal` database comes up empty, ready for queries.

## Overrides

All values are env-overridable (e.g. on the `docker compose` / `npm start` invocation):
`POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `POSTGRES_PORT`, `PGADMIN_EMAIL`,
`PGADMIN_PASSWORD`, `PGADMIN_PORT`.

> Local dev only: `pg_hba.conf` accepts password-gated connections from any address. Do not expose this
> stack beyond your machine.
