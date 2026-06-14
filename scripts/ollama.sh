#!/usr/bin/env bash
#
# Start/stop a single headless `ollama serve` on macOS.
#
# Why this exists: the Ollama.app menu-bar app auto-starts its own server bound
# to 127.0.0.1:11434 and respawns it when killed. Running `ollama serve` by hand
# then fails with "address already in use" (the "blocked" error). This script
# quits the app first so a manual server can own the port cleanly.
#
# Usage:
#   scripts/ollama.sh start     # quit the app, then start headless serve
#   scripts/ollama.sh stop      # quit the app and kill any serve process
#   scripts/ollama.sh restart   # stop then start
#   scripts/ollama.sh status    # show what (if anything) holds the port

set -euo pipefail

HOST="${OLLAMA_HOST:-127.0.0.1:11434}"
PORT="${HOST##*:}"
LOG="${TMPDIR:-/tmp}/ollama-serve.log"

port_pid() {
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null || true
}

stop() {
  # Quit the GUI app first so it can't respawn the server we're about to kill.
  if pgrep -x Ollama >/dev/null 2>&1; then
    echo "Quitting Ollama.app..."
    osascript -e 'quit app "Ollama"' >/dev/null 2>&1 || true
    sleep 1
  fi

  # Kill any remaining serve processes (app-spawned or manual).
  local pids
  pids="$(pgrep -f 'ollama serve' || true)"
  if [ -n "$pids" ]; then
    echo "Stopping ollama serve (PID: $pids)..."
    # shellcheck disable=SC2086
    kill $pids 2>/dev/null || true
    sleep 1
    # shellcheck disable=SC2086
    kill -9 $pids 2>/dev/null || true
  fi

  if [ -n "$(port_pid)" ]; then
    echo "Warning: port $PORT is still held by PID $(port_pid)" >&2
  else
    echo "Ollama stopped. Port $PORT is free."
  fi
}

start() {
  if [ -n "$(port_pid)" ]; then
    echo "Port $PORT already in use (PID $(port_pid)); stopping first..."
    stop
  fi

  echo "Starting ollama serve on $HOST (log: $LOG)..."
  OLLAMA_HOST="$HOST" nohup ollama serve >"$LOG" 2>&1 &
  local pid=$!

  # Give it a moment, then confirm it actually grabbed the port.
  sleep 2
  if kill -0 "$pid" 2>/dev/null && [ -n "$(port_pid)" ]; then
    echo "Ollama running (PID $pid) on $HOST."
  else
    echo "Failed to start. Last log lines:" >&2
    tail -n 20 "$LOG" >&2 || true
    exit 1
  fi
}

status() {
  local pid
  pid="$(port_pid)"
  if [ -n "$pid" ]; then
    echo "Ollama listening on $HOST (PID $pid):"
    ps -o pid,command -p "$pid" 2>/dev/null | tail -n +1
  else
    echo "Nothing is listening on $HOST."
  fi
  if pgrep -x Ollama >/dev/null 2>&1; then
    echo "Note: Ollama.app (menu-bar) is running and may respawn the server."
  fi
}

case "${1:-}" in
  start)   start ;;
  stop)    stop ;;
  restart) stop; start ;;
  status)  status ;;
  *)
    echo "Usage: $0 {start|stop|restart|status}" >&2
    exit 1
    ;;
esac
