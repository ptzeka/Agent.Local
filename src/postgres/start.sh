#!/usr/bin/env bash
# Standalone bring-up for the local Postgres + pgAdmin stack. NOT wired into root npm start — this
# workspace owns its own lifecycle. Build the image (config is baked in), compose up, wait for health.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

# needs a docker runtime: Windows = Rancher Desktop, macOS = colima (or Docker Desktop on either).
# Missing runtime is a clean exit (0), not a failure: npm wraps any non-zero exit in a noisy
# "command failed" dump, so a friendly "here's how to get docker" reads better than that on Windows.
if ! command -v docker >/dev/null 2>&1; then
  echo "[pg] docker not found — install a runtime, then re-run 'npm start':"
  echo "[pg]   Windows: winget install suse.RancherDesktop   (WSL2 backend)"
  echo "[pg]   macOS:   brew install colima && colima start"
  exit 0
fi
if ! docker info >/dev/null 2>&1; then
  echo "[pg] docker is installed but the daemon is unreachable — start your runtime, then re-run 'npm start':"
  echo "[pg]   Windows: launch Rancher Desktop (wait for the engine to go green)"
  echo "[pg]   macOS:   colima start"
  exit 0
fi

echo "[pg] building image (config baked in)..."
docker compose build

echo "[pg] starting postgres + pgadmin..."
docker compose up -d

printf '[pg] waiting for postgres health'
waited=0
while [ "$(docker inspect -f '{{.State.Health.Status}}' agent-local-postgres 2>/dev/null || echo none)" != "healthy" ]; do
  if [ "$waited" -ge 90 ]; then echo; echo "[pg] WARN: not healthy after 90s — see: docker compose logs postgres"; break; fi
  printf '.'; sleep 3; waited=$((waited + 3))
done
echo " up"

echo "[pg] postgres :${POSTGRES_PORT:-5432}  db=${POSTGRES_DB:-agentlocal}  user=${POSTGRES_USER:-agent}"
echo "[pg] pgAdmin:  http://localhost:${PGADMIN_PORT:-5050}  (login ${PGADMIN_EMAIL:-admin@agent.local} / ${PGADMIN_PASSWORD:-admin})"
echo "[pg] psql:     npm run psql"
