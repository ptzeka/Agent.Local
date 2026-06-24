#!/usr/bin/env bash
# Run a one-shot query against a repo SQLite DB, formatted like the repo .sqliterc
# (box table, headers, NULL nullvalue, timer). Backed by better-sqlite3 via Node,
# so no system `sqlite3` binary is required.
#
#   scripts/db.sh host "SELECT * FROM work LIMIT 5;"    # one-shot query, then exit
#   scripts/db.sh agent "SELECT * FROM session LIMIT 5;"
#
# The agent DB only exists after `npm run db:init`. Override either path with
# HOST_DB_FILE / AGENT_DB_FILE (AGENT_DB_FILE is also what the agent process reads).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

which="${1:-}"
case "$which" in
  host)  db="${HOST_DB_FILE:-$ROOT/src/host/data/host.sqlite}" ;;
  agent) db="${AGENT_DB_FILE:-$ROOT/src/agent/data/agent.sqlite}" ;;
  *)
    echo "usage: scripts/db.sh <host|agent> [sql]" >&2
    exit 2
    ;;
esac
shift

if [ ! -f "$db" ]; then
  echo "[db] $db does not exist yet — run: npm run db:init" >&2
  exit 1
fi

# db.mjs applies the .sqliterc presentation (box mode, headers, timer) itself.
exec node "$ROOT/scripts/db.mjs" "$db" "$@"
