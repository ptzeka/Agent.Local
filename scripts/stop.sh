#!/usr/bin/env bash
# Bring down whatever start.sh launched: kill the recorded PIDs, then sweep the ports as a fallback in case
# the npm wrapper spawned a detached child. Safe to run repeatedly.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="$ROOT/scripts/.run"

HOST_PORT="${PORT:-3011}"
AGENT_PORT="${AGENT_PORT:-3020}"
AUTH_PORT="${AUTH_PORT:-3015}"

# kill the process tree rooted at a recorded pidfile, then remove the file
stop_pidfile() {
  local name="$1"
  local file="$RUN_DIR/$name.pid"
  [ -f "$file" ] || { echo "[stop] no $name.pid"; return; }
  local pid; pid="$(cat "$file")"
  if kill -0 "$pid" 2>/dev/null; then
    # pkill (kill the child tree) isn't shipped with Git-for-Windows bash; guard it so its absence
    # isn't fatal — stop_port below is what actually reaps the detached node child on Windows.
    command -v pkill >/dev/null 2>&1 && pkill -TERM -P "$pid" 2>/dev/null || true
    kill -TERM "$pid" 2>/dev/null || true
    echo "[stop] sent TERM to $name (pid $pid)"
  else
    echo "[stop] $name (pid $pid) not running"
  fi
  rm -f "$file"
}

# fallback: kill whatever still holds the port. lsof is the Unix path; Git-for-Windows ships neither
# lsof nor pkill, so the detached node child that binds the port is invisible to bash — there we shell
# out to PowerShell, which can map a listening port to its owning Windows PID and kill it.
stop_port() {
  local name="$1" port="$2" pids
  if command -v lsof >/dev/null 2>&1; then
    pids="$(lsof -ti tcp:"$port" 2>/dev/null || true)"
    [ -n "$pids" ] || return
    echo "[stop] freeing :$port ($name) — pids: $pids"
    # shellcheck disable=SC2086
    kill -TERM $pids 2>/dev/null || true
    return
  fi
  command -v powershell >/dev/null 2>&1 || return
  powershell -NoProfile -Command \
    "Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Write-Host ('[stop] freeing :$port ($name) — pid ' + \$_.OwningProcess); Stop-Process -Id \$_.OwningProcess -Force -ErrorAction SilentlyContinue }"
}

stop_pidfile host
stop_pidfile agent
stop_pidfile auth
stop_port host "$HOST_PORT"
stop_port agent "$AGENT_PORT"
stop_port auth "$AUTH_PORT"

# Temporal is stateful infra (its postgres holds workflow history), so it is left
# running across host/agent restarts by default — start.sh calls this script first,
# and recreating the server each cycle would re-init the datastore. Opt in to tear it
# down too: STOP_TEMPORAL=1 scripts/stop.sh
if [ "${STOP_TEMPORAL:-0}" = "1" ] && command -v docker >/dev/null 2>&1; then
  echo "[stop] bringing temporal down..."
  ( cd "$ROOT/src/temporalhost" && docker compose down ) || true
fi

echo "[stop] done"
