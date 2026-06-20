# @agent-local/workflow

Camunda 8 (Zeebe) workflow integration for Agent.Local. Connects to a Zeebe
broker, deploys a sample BPMN on boot, runs a job worker for the `agent-execute`
service task, and publishes job lifecycle events onto the shared `Eventing` bus.

**Invariant — Camunda always initiates.** The only flow is
`Camunda job → agent dispatch → result → Camunda completes the job → process
advances`. This workspace never starts a process on the agent's behalf; the
worker reacts to activated jobs and reports back over the bus.

## Run a local broker

This workspace is **client-only** — it carries no Camunda runtime. The broker
image lives in [`@agent-local/camundahost`](../camundahost/README.md); bring it
up there, then point this client at it via the env vars below.

```sh
npm run docker:build -w @agent-local/camundahost
npm run docker:up    -w @agent-local/camundahost
```

## Connection env vars

The `@camunda8/sdk` reads connection details from the environment. For the
self-managed single-broker dev setup (OAuth disabled) that camundahost provides:

| Var | Example | Purpose |
|---|---|---|
| `ZEEBE_GRPC_ADDRESS` | `localhost:26500` | Zeebe gateway gRPC endpoint |
| `ZEEBE_REST_ADDRESS` | `http://localhost:8080` | Zeebe REST endpoint |
| `CAMUNDA_OAUTH_DISABLED` | `true` | no auth for local dev |
| `CAMUNDA_SECURE_CONNECTION` | `false` | plaintext gRPC for local dev |

Engine-side knobs owned by this package:

| Var | Default | Purpose |
|---|---|---|
| `WORKFLOW_PORT` | `3100` | standalone express port |
| `WORKFLOW_BPMN_DIR` | `./bpmn` | dir of `*.bpmn` deployed on boot |
| `WORKFLOW_TASK_TYPE` | `agent-execute` | service-task job type the worker registers |
| `WORKFLOW_WORKER_NAME` | `agent-execute-worker` | worker identity |
| `WORKFLOW_RECONNECT_BASE_MS` | `1000` | reconnect backoff base |
| `WORKFLOW_RECONNECT_MAX_MS` | `30000` | reconnect backoff cap |

## Control surface

Registered by `mount(app, ctx)` on the host's express app:

- `POST /workflow/process` — start an instance (`{ bpmnProcessId?, variables? }`)
- `GET /workflow/process/:key` — read a started instance's reflected state
- `GET /workflow/healthz` — broker connectivity

## Events published onto `ctx.bus`

- `workflow.job` `{ processInstanceKey, jobKey, jobType, variables }` — worker activated a job
- `workflow.completed` `{ processInstanceKey }` — a held job was completed out of band
- `workflow.failed` `{ processInstanceKey?, jobKey?, error }` — completion failed

The agent execution itself is deferred. A future `agent.result` event (carrying
`jobKey` + `variables`) drives `completeJob` to refresh Camunda state.
