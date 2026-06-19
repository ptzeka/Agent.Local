#!/usr/bin/env bash
set -euo pipefail

# Wrapper entrypoint: apply single-broker dev defaults, then exec the stock broker.
# Defaults only — any value already in the environment wins, so prod overrides hold.
export ZEEBE_BROKER_NETWORK_HOST="${ZEEBE_BROKER_NETWORK_HOST:-0.0.0.0}"
export ZEEBE_BROKER_GATEWAY_SECURITY_AUTHENTICATION_MODE="${ZEEBE_BROKER_GATEWAY_SECURITY_AUTHENTICATION_MODE:-none}"

# Hand off to the base image's broker launcher under tini (PID 1 stays the broker).
exec /usr/local/zeebe/bin/broker
