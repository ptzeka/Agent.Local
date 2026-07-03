# @agent-local/temporal

Temporal as the workflow engine behind the **`mount(app, ctx)` seam**. The host mounts *one*
engine, chosen by config — the bus event contract (`workflow.start` / `workflow.started` /
`workflow.stop` / `workflow.inject` / `agent.result` …) is engine-neutral, so the agent and mesh
never learn which engine is behind them. This is the M7 thesis made concrete: **the bus is the seam**.

See backlog **M7-9** for the design and decisions.

## What's here (scaffold)

- `temporal-client.ts` — `TemporalClient`, the engine adapter. **Stateless and user-agnostic**:
  Temporal's visibility is authoritative, so it holds no local instance map; ownership lives at the
  host (`JobRegistry`, keyed by `userId`), never in the engine. The `@temporalio/client` is pinned
  behind a local `TemporalCore` interface so tests inject a fake and **no Temporal server is needed**.
- `mount.ts` — same control surface as workflow (`POST /workflow/process`,
  `GET /workflow/process/:key`, `GET /workflow/healthz`) and the same bus subscriptions.
- `config.ts` — `TEMPORAL_*` env (address, namespace, task queue); code-first, so there is no
  BPMN dir to deploy.
- `workflows/` — the first code-first Workflow. `user-table-test.ts` drives the agent through a
  users-table scenario (initialize → create sheet → add record → assert row → return *"user table
  created"*): each step `dispatchAgentTask` (an Activity) publishes the same `workflow.job` the agent
  consumes, then the Workflow blocks on the `agentResult` signal (`TemporalClient.reportResult`)
  before advancing — the Workflow decides done/next. `activities.ts`'s `createAgentActivities(bus)` binds
  the host bus into the Activity so the Workflow code stays pure. Verified by a `@temporalio/testing`
  time-skipping test with the dispatch mocked — no live server or agent.

## Model notes

- Execution identity is `workflowId` (== our `workId`) + `runId`.
- Temporal's visibility (`describe()`) is authoritative — the adapter keeps **no local instance map**.
- Operator inject rides a Signal; retries/incidents are built-in activity RetryPolicy / reset.

**The agent does not complete a job** — it reports task results back (`reportResult` → a Signal); the
Workflow code figures out whether the work is done and what runs next. `reportResult` therefore does
**not** publish `workflow.completed`; that terminal event lands with the worker (deferred).

## Deferred ("add workflow later")

- The real `@temporalio/client` + `@temporalio/worker` adapter (the `TemporalCore` impl) and the
  `worker.ts` that registers `workflows/` + activities. The Workflow/Activity *definitions* now exist
  (`workflows/user-table-test/v1/index.ts`, aggregated by `workflows/index.ts`); what's deferred is running them against a live server.
- Self-managed Temporal Server compose + the live `TestWorkflowEnvironment` E2E.

## Test

```
npm test -w @agent-local/temporal
```

Runs against an injected fake `TemporalCore` — no server, no broker.
