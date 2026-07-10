#!/usr/bin/env bash
# Bring down whatever start.sh launched: kill the recorded PID, then sweep the port as a fallback in case
# the npm wrapper spawned a detached child. Safe to run repeatedly.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="$ROOT/scripts/.run"

AGENT_PORT="${AGENT_PORT:-3020}"

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

stop_pidfile agent
stop_port agent "$AGENT_PORT"

echo "[stop] done"
