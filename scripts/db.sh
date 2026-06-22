#!/usr/bin/env bash
# Open a repo SQLite DB in the sqlite3 shell with the repo's .sqliterc formatting applied.
#
#   scripts/db.sh host          # interactive shell on src/host/data/host.sqlite
#   scripts/db.sh agent         # interactive shell on src/agent/data/agent.sqlite
#   scripts/db.sh host "SELECT * FROM work LIMIT 5;"   # one-shot query, then exit
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

# -init loads the repo .sqliterc (box mode, headers, timer) before the prompt/query.
exec sqlite3 -init "$ROOT/.sqliterc" "$db" "$@"
