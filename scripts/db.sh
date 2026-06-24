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
#
# better-sqlite3's native addon is built for Windows. Under WSL, plain `node` is
# Linux and can't load it ("invalid ELF header"). Re-exec through Windows node.exe
# with Windows-form paths when interop can actually run it; otherwise there's no
# usable runtime here, so point the user at Git Bash. Git Bash itself isn't WSL and
# already runs node.exe, so it falls straight through to the plain exec below.
if grep -qiE 'microsoft|wsl' /proc/version 2>/dev/null; then
  if command -v node.exe >/dev/null 2>&1 && node.exe -v >/dev/null 2>&1; then
    exec node.exe "$(wslpath -w "$ROOT/scripts/db.mjs")" "$(wslpath -w "$db")" "$@"
  fi
  echo "[db] Under WSL the Windows better-sqlite3 addon can't load, and Windows node.exe isn't runnable here (interop disabled)." >&2
  echo "[db] Run this from Git Bash or PowerShell instead." >&2
  exit 1
fi
exec node "$ROOT/scripts/db.mjs" "$db" "$@"
