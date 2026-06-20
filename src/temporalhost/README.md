# @agent-local/temporalhost

The **Temporal Server runtime image** for Agent.Local — a custom container built
`FROM` a pinned `temporalio/auto-setup` base with our dynamic config and startup
script baked in. This is a deploy-only workspace: **no Node app, no agent code.**

This is the *runtime*. The *client* (the `mount(app, ctx)` control surface +
Workflows/Activities) lives in [`@agent-local/temporal`](../temporal/README.md)
and connects here purely via its env endpoint (`TEMPORAL_ADDRESS`). It mirrors
[`@agent-local/camundahost`](../camundahost/README.md), the Zeebe broker runtime
behind [`@agent-local/workflow`](../workflow/README.md).

See backlog **M7-10** for the design and decisions.

## Layout

| Path | Purpose |
|---|---|
| `Dockerfile` | `FROM temporalio/auto-setup` (version via `TEMPORAL_VERSION` build arg) + our layer |
| `dockerfiles/startup.sh` | entrypoint wrapper: applies dev defaults, renders the auth fragment, execs the base auto-setup |
| `config/dynamicconfig/agent-local.yaml` | baked-in dynamic config (no secrets/endpoints) |
| `config/base_template.yaml` | local-authority auth fragment, rendered to `config/base.yaml` and merged ahead of the auto-setup config |
| `docker-compose.yml` | runs the **built** image + its Postgres datastore locally |

> **No workflow definitions are baked into the server image.** Temporal is
> code-first: Workflows/Activities live with the client in
> `src/temporal/src/workflows/` and are registered by that package's worker — the
> server image stays a pure runtime, the same way the broker image carries no BPMN.

## Build & run locally

```sh
# Build + tag the image (override the base with --build-arg TEMPORAL_VERSION=...)
npm run docker:build -w @agent-local/temporalhost

# Bring the server up / tail logs / tear down
npm run docker:up   -w @agent-local/temporalhost
npm run docker:logs -w @agent-local/temporalhost
npm run docker:down -w @agent-local/temporalhost
```

Once up, the server listens on gRPC `:7233` and registers the `default` namespace.
Point the client-only `@agent-local/temporal` at it with `TEMPORAL_ADDRESS=localhost:7233`
(`TEMPORAL_NAMESPACE=default`). Uncomment the `ui` service to inspect Workflows in a
browser on `:8233`.

## Config & secrets

Endpoints and secrets are **never baked into the image** — they arrive via the
environment at run time (same rule as M7-1). The baked `agent-local.yaml` carries
only non-secret single-node dynamic-config defaults; `startup.sh` lets any env value
override the datastore/namespace defaults, so the same image runs unchanged in prod.
Temporal Cloud = the same client, a different endpoint/mTLS — this server host is
then simply not used.

## Local authority (auth)

Off by default so `docker:up` comes up green standalone. When enabled, the server
**trusts `src/host` as the authority**: it validates every caller's bearer JWT against
the host's published JWKS (`/.well-known/openid-configuration/jwks`) using Temporal's built-in JWT key
provider + default claim mapper + default authorizer — **zero custom Go plugin**. This is
the M7-9 decision made concrete: one-way gRPC pull, no inbound surface, and the host mints
its **own** short-lived service token (never the end-user's) for the engine hop.

Enable it (compose service `temporal`, or any deploy env):

```yaml
environment:
  TEMPORAL_AUTH_ENABLED: "true"
  TEMPORAL_JWKS_URI: "http://host.docker.internal:3011/.well-known/openid-configuration/jwks"  # reaches src/host
```

| Env | Default | Meaning |
|---|---|---|
| `TEMPORAL_AUTH_ENABLED` | `false` | render + merge the auth fragment; deny un-tokened calls |
| `TEMPORAL_JWKS_URI` | host JWKS via `host.docker.internal:3011` | where to fetch the host's verify keys |
| `TEMPORAL_JWKS_REFRESH_INTERVAL` | `1m` | how often to re-pull the JWKS |
| `TEMPORAL_PERMISSIONS_CLAIM` | `permissions` | JWT claim Temporal reads roles from |

The token's `permissions` claim must be **Temporal-shaped** — `<namespace>:<role>` (e.g.
`default:write`) plus `temporal-system:read` for cluster calls — so a dedicated host service
user, not the frontend `workflow:read/write` scopes, is what reaches the engine.

> **Namespace bootstrap with auth on.** The default authorizer denies auto-setup's
> un-tokened `tctl namespace register`, so `startup.sh` sets `SKIP_DEFAULT_NAMESPACE_CREATION`
> when auth is enabled. Register `default` once with an admin-claim (`temporal-system:admin`)
> host token after the authority is reachable, e.g.:
> `tctl --address localhost:7233 namespace register default` with the token in the
> `TEMPORAL_CLI_AUTHORIZATION_TOKEN` env.

## CI

A `.github/workflows/temporalhost.yml` build job mirrors camundahost (build live;
registry push + deploy stubbed until a registry/host exists).
