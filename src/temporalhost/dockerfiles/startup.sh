#!/usr/bin/env bash
set -euo pipefail

# Wrapper entrypoint: apply single-node dev defaults, then exec the stock auto-setup.
# Defaults only — any value already in the environment wins, so prod overrides hold.
export DB="${DB:-postgres12}"
export DB_PORT="${DB_PORT:-5432}"
export POSTGRES_USER="${POSTGRES_USER:-temporal}"
export POSTGRES_PWD="${POSTGRES_PWD:-temporal}"
export DEFAULT_NAMESPACE="${DEFAULT_NAMESPACE:-default}"
export DEFAULT_NAMESPACE_RETENTION="${DEFAULT_NAMESPACE_RETENTION:-72h}"
export BIND_ON_IP="${BIND_ON_IP:-0.0.0.0}"
# Bake our dynamic config (COPYed into the image) as the default; env can repoint it.
export DYNAMIC_CONFIG_FILE_PATH="${DYNAMIC_CONFIG_FILE_PATH:-config/dynamicconfig/agent-local.yaml}"

# Local-authority auth, off by default so the image bootstraps standalone (a green docker:up).
# When on, the server trusts src/host's JWKS (TEMPORAL_JWKS_URI) and denies un-tokened calls.
export TEMPORAL_AUTH_ENABLED="${TEMPORAL_AUTH_ENABLED:-false}"
export TEMPORAL_JWKS_URI="${TEMPORAL_JWKS_URI:-http://host.docker.internal:3011/.well-known/openid-configuration/jwks}"
# Render the auth fragment into config/base.yaml; Temporal merges it ahead of the rendered
# docker.yaml. dockerize is the same templater the base entrypoint uses for config_template.yaml.
dockerize -template /etc/temporal/config/base_template.yaml:/etc/temporal/config/base.yaml

# With auth on, the default authorizer denies auto-setup's un-tokened tctl namespace register,
# so skip it — register `default` once with an admin-claim host token (see README) instead.
if [ "$(printf '%s' "${TEMPORAL_AUTH_ENABLED}" | tr '[:upper:]' '[:lower:]')" = "true" ]; then
  export SKIP_DEFAULT_NAMESPACE_CREATION="${SKIP_DEFAULT_NAMESPACE_CREATION:-true}"
fi

# Hand off to the base auto-setup entrypoint, forwarding the command (CMD defaults
# to "autosetup" → schema init + default namespace, then the server). "$@" keeps
# the base's modes overridable (autosetup / develop / bash).
exec /etc/temporal/entrypoint.sh "$@"
