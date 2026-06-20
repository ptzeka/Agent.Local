#!/usr/bin/env bash
# Bring the Postgres + pgAdmin stack down. Default preserves the data volume; pass --wipe to drop it too.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

command -v docker >/dev/null 2>&1 || { echo "[pg] docker not found"; exit 0; }

if [ "${1:-}" = "--wipe" ]; then
  echo "[pg] stopping and removing volumes (ALL data will be lost)..."
  docker compose down -v
else
  echo "[pg] stopping (data volume preserved)..."
  docker compose down
fi
echo "[pg] done"
