#!/usr/bin/env bash
# Clean dist, build all workspaces, then start the auth service (3015), host (3011) and agent server (3020) in
# the background and block until every port is actually listening. PIDs/logs land in scripts/.run for stop.sh.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="$ROOT/scripts/.run"
mkdir -p "$RUN_DIR"

HOST_PORT="${PORT:-3011}"
AGENT_PORT="${AGENT_PORT:-3020}"
AUTH_PORT="${AUTH_PORT:-3015}"

# Node ignores the OS trust store (macOS keychain / Windows Root), so the self-signed *.peritze.com cert must be
# passed explicitly — without it every outbound HTTPS (JWKS verify, agent /healthz probe) fails UNABLE_TO_VERIFY.
# Default to the mkcert root CA (where the dev certs are minted) when present, else the Windows cert path.
DEFAULT_CA="$( (command -v mkcert >/dev/null 2>&1 && echo "$(mkcert -CAROOT)/rootCA.pem") || echo "C:/www/host/certs/peritze.com.crt")"
NODE_EXTRA_CA_CERTS="${NODE_EXTRA_CA_CERTS:-$DEFAULT_CA}"
if [ -f "$NODE_EXTRA_CA_CERTS" ]; then
  export NODE_EXTRA_CA_CERTS
  echo "[start] NODE_EXTRA_CA_CERTS=$NODE_EXTRA_CA_CERTS"
else
  echo "[start] WARN: NODE_EXTRA_CA_CERTS=$NODE_EXTRA_CA_CERTS not found — HTTPS to peritze.com will fail to verify"
  unset NODE_EXTRA_CA_CERTS
fi
TEMPORAL_HEALTH_NAME="agent-local-temporalhost"
TEMPORAL_PORT="${TEMPORAL_PORT:-7233}"
POSTGRES_HEALTH_NAME="agent-local-postgres"
POSTGRES_PORT="${POSTGRES_PORT:-5432}"
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

# Bring the standalone Postgres (pgvector) up and provision it (roles/users/schemas/tables via dbup),
# same best-effort + idempotent contract as ensure_temporal: docker/colima absent or unreachable is a
# warning, never a hard stop. Nothing in the running app connects to it yet — wired ahead of migration.
ensure_postgres() {
  [ "${START_POSTGRES:-1}" = "1" ] || { echo "[start] START_POSTGRES=0 — skipping postgres"; return 0; }
  command -v docker >/dev/null 2>&1 || { echo "[start] docker not found — skipping postgres (see COMMANDS.md)"; return 0; }
  if ! docker info >/dev/null 2>&1; then
    command -v colima >/dev/null 2>&1 || { echo "[start] WARN: docker daemon unreachable, colima not installed — skipping postgres"; return 0; }
    echo "[start] docker daemon unreachable — starting colima..."
    colima start || { echo "[start] WARN: colima start failed — skipping postgres"; return 0; }
  fi
  echo "[start] ensuring postgres is up..."
  ( cd "$ROOT/src/postgres" && docker compose up -d ) || { echo "[start] WARN: postgres compose up failed — continuing without it"; return 0; }
  local waited=0
  printf '[start] waiting for postgres health'
  while [ "$(docker inspect -f '{{.State.Health.Status}}' "$POSTGRES_HEALTH_NAME" 2>/dev/null || echo none)" != "healthy" ]; do
    if [ "$waited" -ge 90 ]; then echo; echo "[start] WARN: postgres not healthy after 90s — continuing"; return 0; fi
    printf '.'; sleep 3; waited=$((waited + 3))
  done
  echo " up"
  # provision is idempotent (guards + IF NOT EXISTS), so re-running on every start is a no-op; a failure
  # here only warns — the app does not depend on postgres yet.
  echo "[start] provisioning postgres (roles/users/schemas/tables)..."
  npm run db:provision --prefix "$ROOT" -w @agent-local/postgres || echo "[start] WARN: postgres provision failed — continuing"
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
wait_for_port_free auth "$AUTH_PORT"

echo "[start] cleaning dist folders..."
npm run clean --prefix "$ROOT"

echo "[start] building all workspaces (in dependency order)..."
# root `npm run build --workspaces` builds in listing order (host before temporal/web), so a clean build
# breaks on missing types. Enumerate every workspace leaves-first so the build mirrors the clean above —
# clean wipes all dist, so all must be rebuilt or the un-listed ones boot with no compiled output.
# --if-present skips workspaces without a build script (e.g. temporalhost), matching the clean step's flag.
npm run build --if-present --prefix "$ROOT" \
  -w @agent-local/common \
  -w @agent-local/vectorizer \
  -w @agent-local/vectorstore \
  -w @agent-local/fsmcp \
  -w @agent-local/openclaw-runner \
  -w @agent-local/temporalhost \
  -w @agent-local/mcp \
  -w @agent-local/web \
  -w @agent-local/temporal \
  -w @agent-local/agent \
  -w @peritze/codeindex \
  -w @peritze/codemcp \
  -w @peritze/memomcp \
  -w @agent-local/auth \
  -w @agent-local/host

echo "[start] initializing databases (host.sqlite, agent.sqlite)..."
npm run db:init --prefix "$ROOT"

ensure_temporal
ensure_postgres

echo "[start] launching auth service on :$AUTH_PORT..."
AUTH_PORT="$AUTH_PORT" npm start --prefix "$ROOT" -w @agent-local/auth >"$RUN_DIR/auth.log" 2>&1 &
AUTH_PID=$!
echo "$AUTH_PID" >"$RUN_DIR/auth.pid"

echo "[start] launching host on :$HOST_PORT..."
PORT="$HOST_PORT" npm start --prefix "$ROOT" -w @agent-local/host >"$RUN_DIR/host.log" 2>&1 &
HOST_PID=$!
echo "$HOST_PID" >"$RUN_DIR/host.pid"

echo "[start] launching agent server on :$AGENT_PORT..."
AGENT_PORT="$AGENT_PORT" npm run start:server --prefix "$ROOT" -w @agent-local/agent >"$RUN_DIR/agent.log" 2>&1 &
AGENT_PID=$!
echo "$AGENT_PID" >"$RUN_DIR/agent.pid"

wait_for_port auth "$AUTH_PORT" "$AUTH_PID"
wait_for_port host "$HOST_PORT" "$HOST_PID"
wait_for_port agent "$AGENT_PORT" "$AGENT_PID"

echo "[start] all up — auth http://localhost:$AUTH_PORT  host http://localhost:$HOST_PORT  agent http://localhost:$AGENT_PORT"
# print the full log dictionary, not just the two .run files: the REPL and Temporal server log elsewhere,
# so a "where are the logs" question is answered once, here, at the end of every start
echo "[start] logs (stop with scripts/stop.sh):"
echo "  auth service           : $RUN_DIR/auth.log"
echo "  host + Temporal worker : $RUN_DIR/host.log"
echo "  agent server           : $RUN_DIR/agent.log"
echo "  agent CLI / REPL       : $ROOT/logs/agent-<MDYYYY>.log   (override: AGENT_LOG_FILE)"
echo "  Temporal server        : docker logs $TEMPORAL_HEALTH_NAME"
echo "  Postgres               : docker logs $POSTGRES_HEALTH_NAME   (pgAdmin http://localhost:5050)"
echo "  verbosity              : LOG_LEVEL=error|warn|info|debug  (or DEBUG=1)"
