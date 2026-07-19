#!/usr/bin/env bash
# Clean dist, build the mcp/agent workspaces, then start the agent server (3020) in the background and
# block until the port is actually listening. PIDs/logs land in scripts/.run for stop.sh.
# Note: the auth service, host, Temporal and web console (formerly co-launched here) now live in the
# separate Agent.Workflow repo and its own scripts/start.sh — start that first (or point AUTH_PORT/PORT
# at wherever it's already running) so the agent's host-client and identity checks have somewhere to talk to.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="$ROOT/scripts/.run"
mkdir -p "$RUN_DIR"

AGENT_PORT="${AGENT_PORT:-3020}"

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
WAIT_SECONDS=60

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

# always start from a clean slate: stop whatever a previous start.sh left running (and sweep the port),
# so a stale in-memory build can never outlive a restart — this script is the single go-to entrypoint.
echo "[start] stopping any running agent..."
bash "$ROOT/scripts/stop.sh"
wait_for_port_free agent "$AGENT_PORT"

echo "[start] cleaning dist folders..."
npm run clean --prefix "$ROOT"

echo "[start] building all workspaces (in dependency order)..."
npm run build --if-present --prefix "$ROOT" \
  -w @agent-local/mcp \
  -w @agent-local/agent

echo "[start] initializing database (agent.sqlite)..."
npm run db:init --prefix "$ROOT"

echo "[start] launching agent server on :$AGENT_PORT..."
AGENT_PORT="$AGENT_PORT" npm run start:server --prefix "$ROOT" -w @agent-local/agent >"$RUN_DIR/agent.log" 2>&1 &
AGENT_PID=$!
echo "$AGENT_PID" >"$RUN_DIR/agent.pid"

wait_for_port agent "$AGENT_PORT" "$AGENT_PID"

echo "[start] all up — agent http://localhost:$AGENT_PORT"
echo "[start] logs (stop with scripts/stop.sh):"
echo "  agent server      : $RUN_DIR/agent.log"
echo "  agent CLI / REPL  : $ROOT/logs/agent-<MDYYYY>.log   (override: AGENT_LOG_FILE)"
echo "  verbosity         : LOG_LEVEL=error|warn|info|debug  (or DEBUG=1)"
echo "  auth/host/temporal: started separately from the Agent.Workflow repo"
