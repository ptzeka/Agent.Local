# Map: entry → turn

Four entry points, one convergence. Everything funnels into `AgentRuntime.dispatchAsync` → `TurnLoop.run`.

```
                                     ┌─ ENTRY POINTS ────────────────────────┐
 cli/index.ts main()                 │                                       │
   ├─ headless  (--run)              │  runHeadless ──────────┐              │
   └─ interactive                    │  runRepl ─┐            │              │
 server /events (SSE)                │  SseReceiver ─┐        │              │
 server /events (one-shot job)       │  ExecutionRunner ──────┤              │
 tool call (dispatch/ask)            │  role-dispatch / executor / sub ──┐   │
                                     └───────────┼──────┼────┼───────────┼───┘
                                                 │      │    │           │
                            injectInput(inbox)◄──┘◄─────┘    │           │
                                     │                       │           │
                            TurnRunner.pump ─► runTurn ──────►│           │
                                                              ▼           ▼
                                              AgentRuntime.dispatchAsync(input, {signal})
                                                              │
                                          composeRunnerPipeline(runnerMiddlewares, …)  ← onion
                                                              │  core
                                                       TurnLoop.run(ctx)
                                                              │
                                    Turn.open ─► runPrologue ─► iterate ─► runEpilogue
```

## 1. Bootstrap (once per process)

[cli/index.ts:130](src/agent/src/cli/index.ts#L130) `bootstrap()` — the composition root: parses `models.json` / `mcp.json` / appsettings **once**, opens the DB, mints the single root `AbortController`, registers `LOGGER`/`DB` into the `Container`, installs SIGINT/SIGTERM → `shutdown()`.

## 2. Runtime assembly

[cli/index.ts:207](src/agent/src/cli/index.ts#L207) `buildRuntime()` packs `AgentRuntimeDeps` (incl. `parentSignal: boot.rootSignal`) → [build-runtime.ts:24](src/agent/src/agent/runtime/build-runtime.ts#L24), an ordered middleware chain. `AgentRuntime.build()` runs it and pulls each subsystem off the container by token — **`TurnLoopMiddleware` is what constructs the `TurnLoop`** ([middleware/turn-loop.ts:23](src/agent/src/agent/runtime/middleware/turn-loop.ts#L23)).

Order matters: `Container → Eventing → Logger → Configuration → Providers → Models → Store → Workspaces → Identity → Session → Conversation → Metrics → SessionManager → McpRegistry → TurnLoop → RunnerPipeline → Context → InputInbox`.

## 3. The four paths in

| Entry | Path | Mode |
|---|---|---|
| **Headless** `--run` | [cli/index.ts:305](src/agent/src/cli/index.ts#L305) | direct `dispatchAsync(input)`, one turn, exit code from `result.outcome` |
| **REPL** | [repl.ts:65](src/agent/src/cli/repl.ts#L65) `startTurnLoop()`, [repl.ts:112](src/agent/src/cli/repl.ts#L112) `injectInput(input,"user")` | inbox + pump; contentless `dispatchAsync('')` |
| **Server SSE** | [ssereceiver.ts:108](src/agent/src/server/comms/ssereceiver.ts#L108) `startTurnLoop`; [runner.ts:85](src/agent/src/server/comms/runner.ts#L85) routes input into the live runtime | persistent runtime, SSE is the sink |
| **Server one-shot job** | [runner.ts:104](src/agent/src/server/comms/runner.ts#L104) | builds under `workflow-orchestrator`, dispatches, publishes result, drains |
| **Sub-session / dispatch tool** | [session-manager.ts:247](src/agent/src/agent/session/session-manager.ts#L247), [role-dispatch-server.ts:83](src/agent/src/agent/synthetic-mcp/role-dispatch-server.ts#L83), [executor-server.ts:200](src/agent/src/agent/synthetic-mcp/executor-server.ts#L200) | full child runtime; reports back via `onNotification` → `injectInput(…, "subsession")` |

## 4. Scheduling seam (`TurnRunner`)

Every non-headless producer writes to **one `InputInbox`**, never calls dispatch. [agent-runtime.ts:317](src/agent/src/agent/runtime/agent-runtime.ts#L317) `rewireTurnWake()` binds `inbox.setOnPush → turnRunner.wake`. The pump ([turn-runner.ts:160](src/agent/src/agent/runners/turn-runner.ts#L160)) serializes turns, so no producer races the `status === "running"` guard at [agent-runtime.ts:177](src/agent/src/agent/runtime/agent-runtime.ts#L177).

## 5. Dispatch → turn

[agent-runtime.ts:176](src/agent/src/agent/runtime/agent-runtime.ts#L176) `dispatchAsync`: pushes input into the inbox (even a direct dispatch — no separate first-message path) → `beginTurn()` builds the per-turn `RunnerContext` with a child `Eventing` → `composeRunnerPipeline` folds runner middlewares around `turnLoop.run(ctx)` as the core → `finally { finalize() }` persists on every exit path.

## 6. Inside the turn

[turn-loop.ts:75](src/agent/src/agent/runners/turn-loop.ts#L75) `run()`:

1. **cold-wake guard** — no pending input → `Turn.idle()`, no model call
2. `Turn.open(ctx, role)`
3. **prologue** ([:158](src/agent/src/agent/runners/turn-loop.ts#L158)) — context provider → compaction → `drainRequest` (one prompt per turn) → contributors
4. **iterate** ([:96](src/agent/src/agent/runners/turn-loop.ts#L96)) — per iteration: abort check → `ModelCaller.call` → tool calls (`report_result` terminates) → else `CompletionPolicy.judge` → settle / fail / nudge
5. **epilogue** ([:133](src/agent/src/agent/runners/turn-loop.ts#L133)) — evaluator pass stamps an independent verdict; annotates only, never changes `outcome`
6. cap → `capped` ([:181](src/agent/src/agent/runners/turn-loop.ts#L181))

## Cancellation thread

`bootstrap` root `AbortController` → `deps.parentSignal` → `AgentRuntime.scope` (`CancellationToken`) → `TurnRunner.parentSignal` → `ctx.signal` → `ModelCaller` / `ToolCaller` / sub-runtimes. One root, wrapped downward — never re-minted.

---

_Indexed against `ptzeka/Agent.Local` @ `921d667`._
