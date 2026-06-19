# @agent-local/camundahost

The **Camunda 8 (Zeebe) runtime image** for Agent.Local — a custom broker
container built `FROM` a pinned Camunda base with our startup script and broker
config baked in. This is a deploy-only workspace: **no Node app, no agent code.**

This is the *runtime*. The *client* (Zeebe job workers + the
`POST /workflow/process` control surface) lives in
[`@agent-local/workflow`](../workflow/README.md) and connects here purely via
its env endpoint. **Camunda always initiates** (see the workflow README).

> Distinct from M4-2's Node app image — camundahost packages the **Camunda**
> image only.

## Layout

| Path | Purpose |
|---|---|
| `Dockerfile` | `FROM camunda/zeebe` (version via `CAMUNDA_VERSION` build arg) + our layer |
| `dockerfiles/startup.sh` | entrypoint wrapper: applies dev defaults, execs the broker |
| `dockerfiles/application.yaml` | baked-in broker config (no secrets/endpoints) |
| `dockerfiles/bpmn/` | process definitions baked into the image at `/usr/local/zeebe/bpmn/` |
| `docker-compose.yml` | runs the **built** image locally |

> **BPMN source of truth stays `src/workflow/bpmn/`** — that's what the client
> deploys over gRPC at boot. `dockerfiles/bpmn/` is a staged copy (Docker can only
> COPY from within this workspace's build context) for a self-contained image and
> a future startup/bucket-pull deploy. Keep the two in sync when a diagram changes.

## Build & run locally

```sh
# Build + tag the image (override the base with --build-arg CAMUNDA_VERSION=...)
npm run docker:build -w @agent-local/camundahost

# Bring the broker up / tail logs / tear down
npm run docker:up   -w @agent-local/camundahost
npm run docker:logs -w @agent-local/camundahost
npm run docker:down -w @agent-local/camundahost
```

Once up, the broker listens on gRPC `:26500` and REST `:8080`. Point the
client-only `@agent-local/workflow` at it with the env vars documented in that
workspace's README (`ZEEBE_GRPC_ADDRESS=localhost:26500`, OAuth disabled). The
worker then deploys its BPMN and parks a job against a real broker — the
live-broker E2E that was pending in M7-1.

## Config & secrets

Endpoints and secrets are **never baked into the image** — they arrive via the
environment at run time (same rule as M7-1). `application.yaml` carries only the
non-secret single-broker dev defaults; `startup.sh` lets any env value override
those defaults, so the same image runs unchanged in prod.

## CI

`.github/workflows/camundahost.yml` builds this image on push/tag. The **build**
job is live; registry push + deploy to the runtime host are stubbed (documented
TODO) until a registry/host exists.
