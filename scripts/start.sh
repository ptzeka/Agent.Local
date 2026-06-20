#!/usr/bin/env bash
# Clean dist, build all workspaces, then start the host (3011) and agent server (3020) in the background
# and block until both ports are actually listening. PIDs/logs land in scripts/.run for stop.sh to use.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="$ROOT/scripts/.run"
mkdir -p "$RUN_DIR"

HOST_PORT="${PORT:-3011}"
AGENT_PORT="${AGENT_PORT:-3020}"
TEMPORAL_HEALTH_NAME="agent-local-temporalhost"
TEMPORAL_PORT="${TEMPORAL_PORT:-7233}"
WAIT_SECONDS=60

# Bring the standalone Temporal server up before host/agent so the workflow engine is
# reachable. Best-effort + idempotent: docker/colima absent or unreachable is a warning,
# never a hard stop — the engine switch is opt-in, so the app still runs without it.
ensure_temporal() {
  [ "${START_TEMPORAL:-1}" = "1" ] || { echo "[start] START_TEMPORAL=0 — skipping temporal"; return 0; }
  command -v docker >/dev/null 2>&1 || { echo "[start] docker not found — skipping temporal (see COMMANDS.md)"; return 0; }
  if ! docker info >/dev/null 2>&1; then
    command -v colima >/dev/null 2>&1 || { echo "[start] WARN: docker daemon unreachable, colima not installed — skipping temporal"; return 0; }
    echo "[start] docker daemon unreachable — starting colima..."
    colima start || { echo "[start] WARN: colima start failed — skipping temporal"; return 0; }
  fi
  echo "[start] ensuring temporal server is up..."
  ( cd "$ROOT/src/temporalhost" && docker compose up -d ) || { echo "[start] WARN: temporal compose up failed — continuing without it"; return 0; }
  local waited=0
  printf '[start] waiting for temporal health'
  while [ "$(docker inspect -f '{{.State.Health.Status}}' "$TEMPORAL_HEALTH_NAME" 2>/dev/null || echo none)" != "healthy" ]; do
    if [ "$waited" -ge 90 ]; then echo; echo "[start] WARN: temporal not healthy after 90s — continuing"; return 0; fi
    printf '.'; sleep 3; waited=$((waited + 3))
  done
  echo " up"
  # Container health is internal (tctl inside the container); also ping the *published* gRPC port from
  # the host so we confirm the 7233 mapping is actually reachable by the host/agent clients, not just
  # healthy in-container. Best-effort to match the rest of ensure_temporal — a missed ping only warns.
  printf '[start] pinging temporal gRPC on :%s' "$TEMPORAL_PORT"
  waited=0
  while ! (exec 3<>"/dev/tcp/localhost/$TEMPORAL_PORT") >/dev/null 2>&1; do
    if [ "$waited" -ge 15 ]; then echo; echo "[start] WARN: temporal :$TEMPORAL_PORT not reachable from host — continuing"; return 0; fi
    printf '.'; sleep 1; waited=$((waited + 1))
  done
  echo " reachable"
}

# poll a TCP port until something accepts connections, or give up after WAIT_SECONDS
wait_for_port() {
  local name="$1" port="$2" pid="$3" waited=0
  printf '[start] waiting for %s on :%s' "$name" "$port"
  # bash's /dev/tcp built-in instead of nc: nc isn't shipped with Git-for-Windows bash, and a TCP
  # connect probe needs no external tool — opening the pseudo-device succeeds iff something is listening.
  while ! (exec 3<>"/dev/tcp/localhost/$port") >/dev/null 2>&1; do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo; echo "[start] ERROR: $name (pid $pid) exited before binding :$port — see $RUN_DIR/$name.log"
      tail -n 20 "$RUN_DIR/$name.log" || true
      exit 1
    fi
    if [ "$waited" -ge "$WAIT_SECONDS" ]; then
      echo; echo "[start] ERROR: $name did not open :$port within ${WAIT_SECONDS}s — see $RUN_DIR/$name.log"
      exit 1
    fi
    printf '.'; sleep 1; waited=$((waited + 1))
  done
  echo " up (pid $pid)"
}

# poll a TCP port until nothing is listening, so a relaunch never races a dying process for the bind
wait_for_port_free() {
  local name="$1" port="$2" waited=0
  while (exec 3<>"/dev/tcp/localhost/$port") >/dev/null 2>&1; do
    if [ "$waited" -ge 15 ]; then
      echo "[start] ERROR: :$port ($name) still held after 15s — run scripts/stop.sh and retry"
      exit 1
    fi
    sleep 1; waited=$((waited + 1))
  done
}

# always start from a clean slate: stop whatever a previous start.sh left running (and sweep the ports),
# so a stale in-memory build can never outlive a restart — this script is the single go-to entrypoint.
echo "[start] stopping any running host/agent..."
bash "$ROOT/scripts/stop.sh"
wait_for_port_free host "$HOST_PORT"
wait_for_port_free agent "$AGENT_PORT"

echo "[start] cleaning dist folders..."
npm run clean --prefix "$ROOT"

echo "[start] building host/agent and their deps (in dependency order)..."
# root `npm run build --workspaces` builds in listing order (host before temporal/web), so a clean build
# breaks on missing types. Build the chain leaves-first explicitly: common -> mcp/web/temporal -> agent/host.
npm run build --prefix "$ROOT" \
  -w @agent-local/common \
  -w @agent-local/mcp \
  -w @agent-local/web \
  -w @agent-local/temporal \
  -w @agent-local/agent \
  -w @agent-local/host

echo "[start] initializing databases (host.sqlite, agent.sqlite)..."
npm run db:init --prefix "$ROOT"

ensure_temporal

echo "[start] launching host on :$HOST_PORT..."
PORT="$HOST_PORT" npm start --prefix "$ROOT" -w @agent-local/host >"$RUN_DIR/host.log" 2>&1 &
HOST_PID=$!
echo "$HOST_PID" >"$RUN_DIR/host.pid"

echo "[start] launching agent server on :$AGENT_PORT..."
AGENT_PORT="$AGENT_PORT" npm run start:server --prefix "$ROOT" -w @agent-local/agent >"$RUN_DIR/agent.log" 2>&1 &
AGENT_PID=$!
echo "$AGENT_PID" >"$RUN_DIR/agent.pid"

wait_for_port host "$HOST_PORT" "$HOST_PID"
wait_for_port agent "$AGENT_PORT" "$AGENT_PID"

echo "[start] both up — host http://localhost:$HOST_PORT  agent http://localhost:$AGENT_PORT"
echo "[start] logs: $RUN_DIR/host.log  $RUN_DIR/agent.log   (stop with scripts/stop.sh)"
