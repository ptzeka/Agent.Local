# BACKLOG — Done

Archive of completed backlog items moved out of [BACKLOG.md](BACKLOG.md). Each
entry keeps its original text and carries a provenance line:

> `_created <date> · updated <date> · by <git user>_`

- **created** — when the item first entered the backlog (git pickaxe: the commit
  that added it).
- **updated** — last meaningful change (here: when it was marked done).
- **by** — the git author of record.

Newest milestones first.

---

## M9 — Consolidation follow-ups

### M9-5 · MCP client enforces the declared response shape
Response-shape validation lived in one tool body
(`synthetic-mcp/role-dispatch-server.ts`), so only that seam got it — a stdio
server declaring the same contract was unchecked, and a second dispatch tool
would have had to re-implement it. The MCP call was already the contract gate
for the payload (`inputSchema`); this closes the other half at the *client*, so
every server, in-process or spawned, is held to its declared output.
- [x] `ToolOutputSchema` + `outputSchema?` on
      [ToolDescriptor](src/mcp/src/tooldescriptor.ts) — the
      `properties`/`required`/`enum`/`default` subset `RoleReturnsSchema`
      already used. `parseDispatchResult`/`validateShape` moved out of
      `runners/policies/dispatch-result.ts` into
      [output-contract.ts](src/mcp/src/output-contract.ts) as
      `parseOutput`/`validateOutput`/`enforceOutputContract`; the agent layer
      keeps only `renderReport`/`stampReport`.
- [x] Enforced in BOTH `Mcp` implementations' `callTool` —
      [LocalMcp](src/mcp/src/local-mcp.ts) and
      [McpClient](src/mcp/src/mcp-client.ts) — through that one helper. A
      conforming body is rewritten to the parsed record; a violation returns
      `isError: true` listing the offending fields; an already-failed call keeps
      the server's own wording. No `outputSchema` ⇒ byte-identical passthrough.
      `McpClient` now indexes descriptors (not bare names) so `callTool` can
      reach the contract, reads `outputSchema` defensively off the SDK's
      `listTools` (optional in the spec, absent on older servers), and both
      implementations advertise it through `listTools`.
- [x] `RoleReturnsSchema extends ToolOutputSchema`, and
      `RoleDispatchLocalMcp` declares `outputSchema: dispatch.returns` on its
      descriptor — the role config stays the single source, and the tool body no
      longer parses or validates its own answer.
- [x] Tests: [output-contract.test.ts](src/mcp/src/tests/output-contract.test.ts)
      — violation names the field, declared `default` fills a gap rather than
      failing, prose/```json-fenced object still parses, usage survives the gate,
      no `outputSchema` is untouched, plus `LocalMcp.callTool` end-to-end.

**Done when:** a server that declares an `outputSchema` and returns a
non-conforming body fails at the client, with no agent-layer code involved. ✔
`@agent-local/mcp` 14/14 and `@agent-local/agent` 249/249 green.

_created 2026-07-28 · updated 2026-07-28 · by ptzeka_

---

## Hardening & consolidation sweep — 2026-07-02

One-day pass driven by a full-repo scan (reusability / security / standard
shapes), not a pre-existing milestone; recorded here as the change-and-decision
log. The still-open residue from the same scan is the new **M9** section in
[BACKLOG.md](BACKLOG.md).

### HS-1 · Standard OAuth 2.0 / JWKS shapes on the auth service
- [x] Token endpoint speaks RFC 6749: §5.1 success (`access_token` /
      `token_type: "Bearer"` / `expires_in`; token-exchange adds
      `issued_token_type`) and §5.2 errors (`invalid_client` 401 +
      `WWW-Authenticate`, `unsupported_grant_type`, `invalid_grant`), with
      form-encoded requests per §4.1.3 (`src/auth/src/auth-api.ts`; clients
      `common/src/access-token-provider.ts` + `agent/src/cli/cli-auth.ts`
      send `URLSearchParams`).
- [x] JWKS moved to the conventional `/.well-known/jwks.json` (was
      `/.well-known/openid-configuration/jwks`); the discovery document now
      advertises `jwks_uri`, both endpoints, grant/response types and S256.
- [x] One JWKS-URL derivation + lazy provider in `@agent-local/common/jwt`
      (`jwksUrlFor`, `createLazyJwksProvider`) replacing the byte-twin
      `host/src/user/jwks.ts` / `agent/src/server/auth/jwks.ts` (both deleted).
- [x] temporalhost `TEMPORAL_JWKS_URI` fixed — it was stale on BOTH the old
      path AND the old host port (JWKS moved to the auth service at the IdP
      split): compose, `startup.sh`, `base_template.yaml`, README.
- [x] Live-verified against a booted auth service: discovery, jwks (one RS256
      key), client_credentials (`expires_in` 900), bad creds → 401
      `invalid_client` + `WWW-Authenticate`, missing grant →
      `unsupported_grant_type`, token-exchange → `issued_token_type`.

  _created 2026-07-02 · updated 2026-07-02 · by Periklis Tzeka_

### HS-2 · Keys and local databases out of git
- [x] RS256 PEM keypairs `git rm`'d (`src/auth/keys/`), dead `src/host/keys/`
      deleted (no references); first-boot regeneration via `loadOrCreateKeyRing`
      verified live; both dirs gitignored.
- [x] `*.sqlite` / `*.sqlite-shm` / `*.sqlite-wal` untracked (`git rm --cached`,
      files kept on disk) + gitignored — local placeholders for the eventual
      cloud stores, never committed. (Committed `appsettings.json` values stay
      by design: local-only, replaced in a deployed state.)

  _created 2026-07-02 · updated 2026-07-02 · by Periklis Tzeka_

### HS-3 · Discards frozen as `zzz_`; Camunda deleted
- [x] `src/fsmcp` → `src/zzz_fsmcp` (live successor:
      `agent/src/agent/synthetic-mcp/fs-tools/`), `src/codemanagermcp` →
      `src/zzz_codemanagermcp`, `src/openclaw` → `src/zzz_openclaw` — out of
      the npm workspaces, FROZEN banner in each README: deliberately
      discarded, kept for reference only. One MCP style remains
      (`McpToolServer`).
- [x] `src/camundahost` + `src/workflow` (the Zeebe client) deleted outright;
      camunda mentions scrubbed from live code and READMEs; stale
      package-lock workspace entries removed. M7's camunda-only stories are
      archived below (M7-1 / M7-5 / M7-7).

  _created 2026-07-02 · updated 2026-07-02 · by Periklis Tzeka_

### HS-4 · Host test foundation (works store + API)
- [x] `host/src/db/db-schema.ts` split: the schema module stays PURE (schema +
      status codes, importable under Jest's CJS transform) while the new
      `db/db-file.ts` keeps the `import.meta` package-root walk on the startup
      path only — this unblocked both new suites.
- [x] `src/host/src/tests/work-store.test.ts`: 10 tests on `:memory:` at the
      real `HOST_SCHEMA` — patch semantics (omitted vs explicit-null),
      temporalId upsert/release, search scoping, cli-vs-job session kinds,
      status FK domain rejection.
- [x] Together with the API-double suites (`tests/api/works-api.test.ts`,
      `agent-cli-api.test.ts` — express router layers driven in-process, no
      listener, no port), the host went 0 → 3 suites / 45 tests green; the
      test tree never resolves the real db path, so `npm test` cannot collide
      with a live host on :3011.

  _created 2026-07-02 · updated 2026-07-02 · by Periklis Tzeka_

### HS-5 · Verified-JWT-only principal at the agent server
- [x] `agent/src/server/middleware/user_context.ts` resolves the caller from
      the verified bearer ALONE — the session-id capability path and the
      staged host stub are gone (a session id is not a principal); `userId` is
      always present (the OBO subject, or the workflow-user on a plain
      dispatch token); anything without `agent:trigger` is 401.

  _created 2026-07-02 · updated 2026-07-02 · by Periklis Tzeka_

### M3-H · Host jobs store → SQLite — `~1d` · P1 — closed by retro-audit 2026-07-02
> **Closed by retro-audit during the sweep:** superseded in place — the host
> runs `WorkStore` over the sqlite `HOST_SCHEMA`
> (`src/host/src/work/work-store.ts`, `db/db-schema.ts`, opened via
> `db/db-file.ts` at boot). `JobRegistry`/`jobs.jsonl` no longer exist; the
> planned `camunda_id` column shipped as `temporalId`; the
> `HOST_STORE=file|sqlite` toggle was never needed (the JSONL data was
> throwaway — sqlite is the only backend). Store behaviour is now pinned by
> the HS-4 tests.

> **Added (2026-06-19):** the host DB (`host.sqlite`, owned by the host
> process) — the second of the two SQLite files. Mirrors M3-1/M3-2 in the host
> package; same user-keyed rule (`user_id` is part of the key, not a filter).
> **dbup foundation landed (2026-06-19):** schema spec
> (`host/src/jobs/db-schema.ts`: `jobs` + `job_status` lookup/FK) applied by the
> shared engine via the `db init` command (`npm run db:init`, called by
> `start.sh`). **Remaining:** the `JobRepository` swap.
- [x] `JobRepository` interface: `add(jobId, userId, workflowId)`,
      `get(jobId)`, `search({userId?, status?})`, `update(jobId, patch)` —
      same surface the host already calls on `JobRegistry` so callers don't
      change. ~~Keep the current `JobRegistry` as `FileJobRepository` (dev/CLI).~~
      *(shipped as `WorkStore`; the file backend was dropped, not kept)*
- [x] `better-sqlite3`; table `jobs(user_id, job_id, workflow_id, status,
      step, session_id, camunda_id, reason, updated_at,
      PRIMARY KEY(user_id, job_id))`, index on `(user_id, status)`. WAL mode.
      Current-state row per job (no event log — append history was only there
      for torn-write safety, which transactions remove). *(shipped as the
      `HOST_SCHEMA` work tables; `camunda_id` became `temporalId`)*
- [x] ~~Swap in via config toggle (`HOST_STORE=file|sqlite`), mirroring
      `AGENT_STORE`.~~ No migration — existing `jobs.jsonl` was throwaway.
      *(toggle never needed; sqlite is the only backend)*

**Done when:** host lists/searches works through the store; a user's `search`
returns only their own jobs via the indexed `(user_id, status)` lookup, not a
full-file fold. — **met** (`WorkStore.search({ userId, status })`).

  _created 2026-06-19 · updated 2026-07-02 · by Periklis Tzeka_

---

## M8 — Frontend epic (React console + API)

Completed slices of the M8 frontend epic (see [BACKLOG.md](BACKLOG.md) for the open
M8-2…M8-6 sequence).

### M8-1 · React + express scaffold (sandbox conventions) — `~2d` · P1
- [x] New workspace `@agent-local/web` (`src/web`): React 19 + react-router 7 +
      **MUI**, **Webpack 5 + Babel**, three bundles (client / standalone server /
      `mount` library) via `webpack.dev.mjs` / `webpack.prod.mjs`. No Vite. *(2026-06-17)*
- [x] Streaming SSR (`renderToPipeableStream`) server (`src/web/src/server/`),
      mountable into the host via `mount(app, ctx)` (the host imports the ESM
      `dist/server/mount.js` library + co-located static assets). *(2026-06-17)*
- [x] Startup scripts: `dev` (concurrent webpack watch + nodemon), `build`,
      `start`, `clean`. *(2026-06-17)*
- [x] Minimal shell — MUI-themed layout, one react-router 7 route, hello page, a
      health badge hitting `GET /healthz`. No feature views yet (M8-3). *(2026-06-17)*
- [ ] `/api` tunnel + `webpack serve` dev-proxy parity — deferred to M8-2 (no API
      to tunnel to yet).

**Done when:** ~~…~~ — **met 2026-06-17**: web builds all bundles, the co-hosted
`@agent-local/host` SSR-renders the React shell at `/`, serves `/static/app.js`
(200), and the health badge reads the live host `/healthz`. Verified end to end.

_created 2026-06-17 · updated 2026-06-17 · by Periklis Tzeka_

---

## M7 — Workflow engine & host

Completed slices of the M7 milestone (see [BACKLOG.md](BACKLOG.md) for the open
M7 sequence).

> **Camunda retired — 2026-07-02** (see HS-3 above): `src/camundahost` and
> `src/workflow` (the Zeebe client) were deleted from the repo. The three
> camunda-only stories below are archived as-is — what they proved (the mount
> seam, the engine-neutral bus vocabulary, deploy-only runtime workspaces)
> carried over to Temporal (M7-9/M7-10); their unchecked bullets are retired,
> not open.

### M7-1 · Camunda 8 workflow engine + express bootstrap — retired 2026-07-02
A new `src/workflow` workspace: an express service that hosts Zeebe job workers
and a thin control surface over a self-managed Zeebe broker.
- [x] New workspace `@agent-local/workflow` (`src/workflow`), `@camunda8/sdk`;
      signal wiring (one root `AbortController` in `main.ts`, `ctx.signal` threaded
      to `stop()`). Express bootstrap itself lives in `@agent-local/host`; workflow
      exposes a `mount(app, ctx)` it registers into. *(2026-06-17)*
- [x] Self-managed Zeebe broker via `docker-compose.yml` (`camunda/zeebe:8.7.6`,
      Operate commented optional); endpoint + auth from env, never hard-coded. *(2026-06-17)*
- [x] `ZeebeClient` wrapper: deploys `src/workflow/bpmn/*.bpmn` on connect; control
      surface `POST /workflow/process` (start) + `GET /workflow/process/:key`
      (state) on the mounted app. *(2026-06-17)*
- [x] Job worker for task type `agent-execute`: publishes `workflow.job` to the bus
      and `forward()`s to hold the job open. *(2026-06-17)*
- [x] Resilience: reconnect-with-backoff, graceful `stop()` on `ctx.signal` that
      never throws, broker-down-at-boot does not crash; `GET /workflow/healthz`. *(2026-06-17)*
- [x] Sample BPMN (`agent-execute.bpmn`) + 4 Jest tests against an injected fake
      gRPC. *(2026-06-17)*
- [ ] ~~Live-broker E2E~~ — **retired 2026-07-02**: the broker was never
      deployed live and the module is deleted; the live-engine E2E lives in
      M7-10 (Temporal).

  _created 2026-06-17 · updated 2026-07-02 · by Periklis Tzeka_

### M7-5 · Camunda IAM identity inheritance for the worker runtime — `~1.5d` · P1 — retired 2026-07-02
> **Retired unbuilt:** the underlying need (the runtime executes as the
> workflow's identity, per instance, not an ambient token) was met on the
> Temporal path by the OBO/token-exchange work instead — the host mints
> per-call service/OBO tokens (M2-9 mint side, M8-7c3) and the agent binds the
> verified subject per session (HS-5). Nothing Camunda-shaped remains to build.

Camunda runs each process under an IAM identity (service account / similar). The
agent worker should **inherit that identity for the process**, so the runtime
executes as the workflow's identity rather than an ambient token. Today
`buildWorkerRuntime` sets `credentials` from a static `AGENT_API_TOKEN` env — the
target is the process's IAM identity carried on the job (IAM identity vs
JWT-as-middleware).
- [ ] Carry the identity on the bus: `workflow.job` / `agent.job` include the
      instance's IAM identity (or a token/assertion to exchange), populated from the
      Camunda job/process variables or job headers. *(retired)*
- [ ] Worker passes it into the runtime as `credentials` (`IdentityContext`) per
      instance instead of the ambient `AGENT_API_TOKEN`; the runtime's identity
      middleware consumes it. *(retired)*
- [ ] Identity is **per process instance** (matches the one-session-per-instance
      lifetime, M7-3/M7-4) — every job of the instance runs as the same identity. *(retired)*
- [ ] Tests: a job carrying an identity builds a runtime whose `IdentityContext`
      reflects it; absent identity falls back to anonymous/dev. *(retired)*

  _created 2026-06-18 · updated 2026-07-02 · by Periklis Tzeka_

### M7-7 · `src/camundahost` — Camunda runtime image (Dockerfile + local build + CI deploy) — `~1d` · P1 — retired 2026-07-02
> **Deleted 2026-07-02** along with `src/workflow`; the verify bullet never ran
> (no Docker on the scaffold host). The pattern it established — a deploy-only
> runtime workspace mirroring the client package — lives on as
> `src/temporalhost` (M7-10) and `src/postgres`.

The Camunda runtime gets its **own deploy workspace**, separate from the Node side.
Today the broker is an inline `camunda/zeebe:8.7.6` in `src/workflow`'s
`docker-compose.yml` (M7-1); that conflates the *client* (Zeebe job workers +
control surface) with the *runtime* (the broker container). Split them: a new
`src/camundahost` owns the Camunda runtime image — a `Dockerfile` `FROM` a Camunda
base with our startup scripts + broker/BPMN config baked in — its local build/run
commands, and the future CI pipeline that builds and deploys it. This is distinct
from M4-2 (the **Node app** image); camundahost is the **Camunda** image only.

> **Decision 2026-06-19:** `src/workflow` is **client-only** — no Camunda runtime,
> no broker compose. It keeps the Zeebe workers + `POST /workflow/process` control
> surface and connects to the broker purely via the env endpoint (M7-1 rule), which
> camundahost now provides. The runtime moves out of workflow entirely.

- [x] **New workspace `@agent-local/camundahost` (`src/camundahost`)** owning the
      runtime container only (no Node app, no agent code). Holds the package/docker
      config: `Dockerfile`, a `dockerfiles/` dir for the copied-in artifacts
      (startup scripts, `application.yaml`/Zeebe config, BPMN), and a `package.json`
      carrying the build/run scripts below. Registered in the root workspaces array.
- [x] **Dockerfile = Camunda base + our layer.** `FROM` the pinned Camunda base
      (`camunda/zeebe:8.7.6` to match M7-1 — version configurable via the
      `CAMUNDA_VERSION` build arg), then `COPY` from `src/camundahost/dockerfiles/`
      `startup.sh` + `application.yaml` into the image; entrypoint is our script. No
      secrets or endpoints baked in — env at run time only (same rule as M7-1).
- [x] **Remove the broker from `src/workflow`.** Deleted `src/workflow/docker-compose.yml`
      (it only held the broker); the workflow README now points at camundahost and
      workflow keeps connecting via its env endpoint unchanged. The only Camunda
      *runtime* definition in the repo now lives in camundahost.
- [x] **Local build/run commands** as workspace npm scripts: `docker:build` (build
      + tag from the Dockerfile/build args), `docker:up` / `docker:down` / `docker:logs`
      (run the **built** image via a thin compose, optional Operate commented like
      M7-1). One-liner documented in the workspace README.
- [x] **Future CI yml pipeline (scaffold now, deploy stubbed).** `.github/workflows/camundahost.yml`
      builds the image on push/tag/PR (path-filtered). The **build** job is live;
      registry push + a gated (`if: false`) deploy job are documented `TODO(infra)`
      until a registry/host exists — build verifiable in CI immediately, deploy
      activates when infra lands.
- [ ] Tests/verify: `npm run docker:build -w @agent-local/camundahost` produces a
      runnable image; `docker:up` brings the broker up and the (client-only)
      `src/workflow` worker connects + deploys its BPMN against it — this is exactly
      the **live-broker E2E still pending in M7-1**, now unblocked by a one-command
      local broker. _(Pending a host with Docker — not installed in the scaffold env.)_
      *(retired — module deleted)*

  _created 2026-06-19 · updated 2026-07-02 · by Periklis Tzeka_

### M7-14 · Dispatch fail-envelope on a thrown agent turn — `~0.5d` · P0
A dispatched (one-shot job) turn that THREW — a provider 5xx, a build failure, a capped
run — was swallowed: the runner published `EXECUTION_RESULT` only on the success line and
the throw escaped to a bare `.catch(log)`
([runner.ts](src/agent/src/server/comms/runner.ts)). So no `agent.result` ever reached the
host, the workflow blocked forever on the `agentResult` signal that would never arrive, the
engine kept reporting `running`, and the per-step session leaked (closed only on
`agent.result` or a terminal sweep, neither of which fired). Surfaced by the M7-13 per-step
model, which made the leaked session visible; root-caused on a live work whose step-1 turn
hit a Gemini `503 UNAVAILABLE`.
- [x] Wrap the one-shot build+dispatch so a thrown turn publishes a fail ENVELOPE
      (`{ status: "fail", result: { error } }`, `outcome: "failed"`) instead of only logging
      — only an expected, completed turn counts as success; everything else bubbles up as a
      fail verdict the host can act on.
- [x] Carve-out: a deliberate cancel (`signal.aborted` from `EXECUTION_CANCEL` on a host
      Stop/pause) publishes nothing and returns, so a paused step is re-dispatched on resume
      rather than wrongly failed.
- [x] Cascade now completes end-to-end (no host/temporal/schema change needed):
      `EXECUTION_RESULT(fail)` → `agent.result(outcome:failed)` → `reportResult` → workflow
      fails the step → `workflow.failed` → `markFailed` → work `attention` +
      `closeAllJobSessions` sweeps the step session.

**Done when:** ~~…~~ — **met 2026-06-24**: a thrown one-shot turn settles its work to
`attention` and releases its step session instead of hanging `running`; the abort path still
drops the answer for re-dispatch. Agent suite green (184 tests).

_created 2026-06-24 · updated 2026-06-24 · by Periklis Tzeka_

### M7-13 · Per-step agent sessions — `kind` job|cli, keyed (work_id, run_key, step_key) — `~2d` · P1
Reshapes M7-6's "**1 agent session = 1 work/execution**" into one session **per dispatched
step**, so steps of one work no longer share (and overlap in) a single master conversation.
- [x] `work_agent_session` table carries `kind` ∈ {`job`,`cli`} plus `run_key` (Temporal
      runId) and `step_key` (dispatch ordinal). Two partial unique indexes: one `cli` per
      work; one `job` per `(work_id, run_key, step_key)` (new `where` partial-index support
      added to the shared `common/db.ts` schema helper).
- [x] Sessions minted at dispatch (`WorkService.open`, host-minted id the agent creates
      as-is) and released when the step's `agent.result` lands (`close`); a work's
      stop/complete/fail/reconcile sweeps ALL job sessions, and a reset (new `run_key`)
      discards them up front. `cli` stays one-per-work.
- [x] Dispatch carries `runKey` (`workflowInfo().runId`, replay-safe) + `stepKey` instead of
      a pre-minted sessionId; `agent.result` threads `sessionId` back so the host closes the
      right step session. `WorkRecord.sessionId` removed (no longer a 1:1 fold).
- [x] `StepSessionResolver` port wires sender (transport) ↔ WorkService (state) via a setter,
      breaking the construction cycle.

**Done when:** ~~…~~ — **met 2026-06-24**: each dispatched step gets its own isolated agent
session; a work accrues many job sessions opened at dispatch and swept at terminal/reset.
Builds clean across common/temporal/host/agent/web; temporal 17/17 and agent tests pass.
Supersedes the `sessionId` 1:1 line in M7-6.

_created 2026-06-24 · updated 2026-06-24 · by Periklis Tzeka_

### M7-12 · Neutralize the agent comms contract — symmetric `/receive`, thin transport adapters — `~1d` · P1
The host↔agent seam today speaks the workflow engine's vocabulary on the wire: the
agent's inbound route is `POST /events` carrying a `{ eventType, payload }` envelope
whose only accepted type is `WORKFLOW_JOB`, and the answer echoes `temporalId`/`jobKey`
back ([comms/contract.ts](src/agent/src/server/comms/contract.ts),
[comms/receiver.ts](src/agent/src/server/comms/receiver.ts#L58-L65)). The agent should
not know what a "temporal" is. Worse, the receiver is a **fat** class — it terminates
HTTP *and* builds the runtime *and* runs the turn inline ([receiver.ts:52-72](src/agent/src/server/comms/receiver.ts#L52-L72)),
so transport and execution are fused. Split them and neutralize the contract so the
wire is engine-agnostic and the agent stays a thin host over the runtime (per the
host-agnostic direction: transport is a host, the runtime never knows about HTTP).

**Symmetric peers.** Both host and agent expose `POST /receive` (HTTP + JWT) and each
has a Sender that POSTs to the other's `/receive`. No `/events`, no event-typed
envelope on the wire — each `/receive` is side-specific, so there is nothing to
discriminate (agent's always gets an `ExecutionRequest`, host's always an
`ExecutionResult`). POST the body directly.

**Three roles, not one.** `HttpReceiver` (transport only: route + JWT + parse + map to
one internal bus event) → `Runner` (subscribes, builds the per-job runtime, runs the
turn, publishes a result event — the relocated `receive()` body) → `HttpSender`
(subscribes, POSTs `ExecutionResult`). The internal `Eventing` bus **stays** — it is
exactly the seam the Receiver converts *into*; the wire payloads are the HTTP contract,
the bus events the internal contract, and they may differ (the Receiver enriches the
event with `source`/`createdAt` so the Runner/Sender never touch the JWT).

**Neutral correlation.** `sessionId` (on the `x-session-id` header) is the routing key
the host maps back to `workId` via its own table; `runId` is host-supplied, opaque to
the agent, echoed on the result (host may use its workflow run id). `temporalId`/`jobKey`
leave the agent entirely — engine routing becomes host-private state keyed by
`sessionId`.
- [x] Wire contract (replaces `WORKFLOW_JOB`/`AGENT_RESULT` envelopes):
      `ExecutionRequest { runId, input }` inbound (sessionId off the header),
      `ExecutionResult { sessionId, runId, source, createdAt, result, outcome }`
      outbound. `outcome` stays the turn verdict so the host fails a step without
      sniffing the text. → `comms/contract.ts` on both sides (the host mirrors the
      shapes; the bus events `EXECUTION_REQUESTED`/`EXECUTION_RESULT` are the agent's
      internal contract, distinct from the wire).
- [x] `HttpReceiver`: renamed `/events` → `/receive`; parses `ExecutionRequest`, lifts
      `sessionId` from the header and `source` from `req.userContext.userInfo.serviceId`
      (= verified `claims.sub`), stamps `createdAt`, publishes ONE `EXECUTION_REQUESTED`,
      ACKs 202. No runtime construction in this class. → `comms/receiver.ts`.
- [x] `ExecutionRunner`: subscribes `EXECUTION_REQUESTED`, builds the per-job runtime
      (the relocated `buildForJob`), runs the turn, publishes `EXECUTION_RESULT`, drains
      the runtime. Runtime construction lives here now, off the transport class. →
      `comms/runner.ts`, wired in `server/index.ts`.
- [x] `HttpResultSender`: subscribes `EXECUTION_RESULT`, POSTs `ExecutionResult` to the
      host's `/receive` (existing `settings.host.receiveUrl`); keeps the cached-bearer
      JWT attach. → `comms/sender.ts`.
- [x] Enforce JWT on the job path so `source` is reliable: `/receive` rejects 401 when
      `authentication.required` and the caller is not token-verified. Added
      `authenticated` to `IRequestUserContext` (true only on the verified-JWT branch) so
      the session-capability/stub paths can't be mistaken for a client id. →
      `middleware/user_context.ts`, gate in `comms/receiver.ts`.
- [x] Mirror the host side: its inbound stays `POST /receive`, its Sender now POSTs an
      `ExecutionRequest` to the agent's `/receive`; the host translates at the boundary
      (`runId` = its `temporalId` == `workId`) so the engine vocabulary stays on its own
      bus. → `src/host/src/comms/{sender,receiver,contract}.ts`, `events.ts`
      (`AgentResultPayload` drops dead `jobKey`, gains `outcome`).
- [ ] OBO seam (depends on M2-9): once `sub` becomes the end user and `act.sub` the
      dispatching service, re-point `source` to `act.sub` so "who sent it" stays the
      actor — leave a code note at the lift site so the meaning doesn't silently flip.
- [x] Tests: a request missing a verified bearer is 401 (no token-less accept on
      `/receive`); a valid request publishes one internal event and ACKs 202 without
      running a turn in the route; the published event carries `source == claims.sub` and
      the echoed `runId`, with no `temporalId`/`jobKey`/`eventType`. → 3 tests in
      `tests/server/receiver.test.ts` (host translation covered by `tsc`; a host runtime
      test is blocked on jose/ESM in the host's `userContext` chain — noted, not built).

**Done when:** the host POSTs an `ExecutionRequest` to the agent's `/receive`, the
Receiver maps it to a bus event (no runtime work in the HTTP class), the Runner executes
and the Sender POSTs an `ExecutionResult { sessionId, runId, source, createdAt, result,
outcome }` to the host's `/receive` — with no engine vocabulary (`temporalId`/`jobKey`/
`eventType`) anywhere on the wire and JWT enforced both directions. ✅ DONE (OBO
`source`→`act.sub` re-point deferred to M2-9) — _by ptzeka_

_created 2026-06-21 · updated 2026-06-21 · by ptzeka_

---

## M1 — Loop reliability & cost

Completed slices of the M1 milestone (see [BACKLOG.md](BACKLOG.md) for the open
M1 sequence and the M1-4 prompt-cache slices below).

### M1-1 · Provider retry/backoff — `~1.5d` · P0
A transient model error (overloaded `503 UNAVAILABLE`, `429` too-many-requests, 5xx) threw
straight through `provider.chat` → orchestrator → caller with NO retry, so a "try again
later" blip killed the whole turn (chat died; a job step failed). Hit in normal chat use on
Gemini `gemini-2.5-flash-lite`.
- [x] Shared `retryTransient(fn, { signal, maxAttempts, baseDelayMs, shouldRetry })` +
      `isTransientError` ([retry.ts](src/agent/src/agent/providers/retry.ts)): retry on
      429/5xx (read off the SDK error's numeric `.status`, falling back to
      `UNAVAILABLE`/`RESOURCE_EXHAUSTED`/`INTERNAL`/`overloaded` in the message); jittered
      exponential backoff; abort-respecting; hard cap; rethrows the ORIGINAL error past the
      cap so downstream handling (the M7-14 fail-envelope) still runs.
- [x] Wired into both cloud providers' `chat`
      ([gemini-provider.ts](src/agent/src/agent/providers/gemini-provider.ts),
      [anthropic-provider.ts](src/agent/src/agent/providers/anthropic-provider.ts) — Anthropic
      `529 overloaded`/`429`), threading the turn `signal`.
- [x] Streaming carve-out: a `hasStreamed` flag makes `shouldRetry = isTransient &&
      !hasStreamed`, so a mid-stream failure (tokens already shown) never re-emits; only a
      clean pre-token failure (the common 503 at request time) retries.
- [x] Non-retryable errors (400 schema, auth, bad model) pass through immediately.
- [x] Tests ([retry.test.ts](src/agent/tests/providers/retry.test.ts)): succeeds-after-2,
      gives-up-after-cap (rethrows original), abort-during-backoff, terminal-no-retry,
      shouldRetry-veto, plus `isTransientError` classification.

> **Divergence from the original spec:** implemented as a shared helper called inside each
> provider's `chat`, NOT a `RetryingProvider implements LLMProvider` decorator wrapped at
> construction in `providers/index.ts`. Same guarantees; the streaming no-double-emit carve-out
> is cleaner in-provider (the decorator can't see deltas). **`retry-after` header honoring is
> NOT implemented** (backoff is jitter-only) — left as a follow-up if a provider's `Retry-After`
> proves materially better than jitter.

**Done when:** ~~…~~ — **met 2026-06-24**: a transient 503/429 is retried with backoff and the
turn succeeds instead of erroring out; a persistent outage falls through to the fail-envelope.
Agent suite green (184 tests, +9 for retry).

_created 2026-06-10 · updated 2026-06-24 · by Periklis Tzeka_

### M1-13 · Required-field presence check at the client — `~0.5d` · P1
Scope deliberately minimal: the client checks ONLY that a tool's declared
`required` keys are present; the servers throw the rest. Value-level validation
already lives server-side and stays there — fsmcp Zod-parses every arg
(`fsmcp/src/server.ts` L46 `schema.parse`, errors caught into `isError` at L165),
so types/enums/bounds/required are all enforced for free; the synthetic LocalMcp
tools (dispatch/subsessions/excel) hand-read `args.x ?? default` and keep their
own value guards (e.g. the non-empty `intent` check). The gap the client closes
is uniform PRESENCE: synthetic tools never parse their hand-written schema, so
`required`/`enum` there are advisory, and a missing field yields a tool-specific
string (`[dispatch-error] intent is required`) instead of one recoverable error.
Every tool already carries `inputSchema` on its `ToolDescriptor` and
`ScopedToolClient` already resolves `name → { client, toolTail }` before dispatch
(L30-39), so the `required` array is in hand at the choke point. Lands as the
**VALIDATE layer of the ToolPort (MR-1)**, not a new chokepoint.
- [x] Required-presence ONLY: read the resolved tool's `inputSchema.required`,
      verify each key exists in `args`, before `client.callTool`. No ajv, no
      type/enum/pattern engine (none of our schemas use `pattern`/regex anyway,
      and one conditional-required case — codemcp `repository`, "REQUIRED when
      auto-detection failed" — is runtime-only and must be left to the tool). A
      ~20-line key walk, not a schema library. → `missingRequired()` helper in
      `scoped-tool-client.ts`.
- [x] Corrective error on a missing key: `{ isError: true, content }` naming the
      absent field(s) (reuse the `ScopedToolClient` corrective-error pattern) so
      the loop re-plans and re-emits — never throw.
- [x] Presence ≠ non-empty: `required` only checks the key exists, so
      `intent: ""` passes here by design — empty/whitespace is a VALUE problem
      the server keeps rejecting (dispatch keeps its `if (!intent)` guard). Do
      NOT fold value checks into the client.
- [x] Leave server-side validation untouched: fsmcp's Zod parse and the
      synthetic value guards stay. dispatch's `if (!intent)` doubles as the
      empty-string value guard, so it stays as-is (it is the value arm).
- [x] Tests: a dispatch with `intent` absent is rejected at the client with a
      field-named error (not the old string) and never reaches the executor; a
      present-but-empty `intent` still falls through to the server's existing
      guard; a fully-valid call passes untouched. → 6 tests in
      `tests/scoped-tool-client.test.ts`.

**Done when:** a tool call missing a `required` key returns one uniform
field-named corrective error from the client and the mutation never runs, while
all value-level validation (types, enums, empty-string) stays server-side. ✅ DONE

_created 2026-06-15 · updated 2026-06-15 · by Periklis Tzeka_

---

## MR — Unified runtime refactor

Completed slices of the MR milestone (see [BACKLOG.md](BACKLOG.md) for the open
MR-1…MR-6 sequence and [UNIFIED_RUNTIME_PLAN.md](UNIFIED_RUNTIME_PLAN.md) for design).

### MR-4·0 · Context consolidation — `RunnerContext` is the bundle — `~0.5d` · P1
Per-turn state was split across **three** carriers (`RunOptions` → `Orchestrator.run`;
`RunnerContext` → the runner onion; `this.runtime` reached back into inside `run()`).
The funnel model (UNIFIED_RUNTIME_PLAN §2.0) is one context per layer:
RuntimeContext → **RunnerContext** → ToolContext → SubRuntimeRefs. Decision (this
session): the orchestrator is just a runner, so `RunnerContext` is the single per-turn
bundle — **anything driven in the loop (executor/evaluator/summarizer) is a runner and
gets a `RunnerContext`.** No separate `TurnContext` type. DI is all singletons, so the
runtime handle rides through on the context rather than being wired in via a setter.

- [x] Folded `RunOptions` (`signal`, `coordinator?`, `pullInjectedPrompts?`) onto
      `RunnerContext`; `AgentRuntime.beginTurn(options)` mints the one `RunnerContext`
      and `dispatchAsync` no longer constructs a second per-turn object.
- [x] DI rides through as a handle (singletons — §2.0 rule): added `runtime:
      AgentRuntimeQueryable` to `RunnerContext`; **retired `Orchestrator.setRuntime`
      + the `private runtime!` field** — `run(ctx)` reads everything off `ctx`. Killed
      the deferred-reference smell at `agent-runtime.ts` (the post-build setter).
- [x] Micro-cleanups in the same pass: dropped the dead `includeSubSessions` from
      `OrchestratorMiddlewareParams` (read only by `ContextMiddleware`) and the
      redundant `?? "orchestrator"` default (role is required).
- [x] **Scope note:** state-derived artifact pre-resolution (provider, surface, context
      snapshot, tracker) was **deferred to MR-4** — this story only changed *where the
      handle comes from* (ctx, not `this`); `run()`'s internal setup is untouched.

**Done when:** `Orchestrator.run` takes a single `RunnerContext` arg and imports nothing
from the runtime to reconstruct state; `setRuntime` and `RunOptions` no longer exist;
suite green. ✅ DONE — `grep -rn "setRuntime\|RunOptions" src/agent/src` clean; tsc clean;
32 suites / 165 tests green.

_created 2026-06-16 · updated 2026-06-16 · by Periklis Tzeka_

---

## M3 — Engine extraction (vectorizer / vectorstore / mcp / codemcp / memomcp)

Completed slices of the "split into 5 packages" grooming. All 6 packages shipped.

### External MCP per-session mounting — `~1d`
Enables the agent to connect to external stdio MCP servers (declared in `mcp.json`) at
runtime, with per-session isolation. Prerequisite for M3-18 (start-of-turn memory recall).

- [x] `runtime/middleware/external-mcp.ts`: `readMcpServerDefs` (reads `mcp.json` without
      throwing on missing file) + `mountExternalMcp` (spawns one stdio server, wraps as `Mcp`,
      self-disposes on `runtimeSignal`). `defaultCwd` resolves the package root from the
      script path so codemcp's index auto-discovery works without per-server `cwd` config.
- [x] `McpRegistryMiddleware` updated to `await mountServers`: synthetic servers matched by
      name; any unrecognized name looked up in `mcp.json` and spawned as stdio. Declared-but-
      unmounted semantics preserved for the executor.
- [x] memomcp wired as a **per-session** server: `memoryCollectionFor(session)` derives the
      collection id from the session; `memomcp` is appended with `--collection <id>` so each
      spawned instance reads/writes only that session's memories. Added to executor + orchestrator
      `mcp` lists in `models.json`.
- [x] `session.ts` gets `memoryCollectionFor` helper; tests in `tests/middleware/external-mcp.test.ts`.

**Done when:** the agent mounts external stdio servers from `mcp.json` at build time with no
registry-side teardown, memomcp runs per-session-scoped, and the declared-but-unmounted executor
semantics are unchanged. ✅ DONE
  _created 2026-06-15 · updated 2026-06-15 · by Periklis Tzeka_

### `src/codemcp` on the engine — `~1d` · P2
Part of the M3-7 "split into 5 packages" grooming (package 4 of 6). Migrates codemcp's
retrieval layer onto the shared `vectorstore` + `vectorizer` packages, adding the two-tier
locate→expand and related_code tools from M3-14/M3-15.

- [x] `codeRetrieval.ts` updated: `CodeRetrieval` wraps `IVectorStore`; `searchByEmbedding`,
      `findSymbol`, `getFileChunks` route through the generic store; code fields (area/kind/
      symbol/lines/imports) live in `metadata` via `toChunkRow`/`toFilter`. `IVectorService`
      (from `vectorizer`) drives query embedding.
- [x] Two-tier tools added: `locate_code`/`locate_symbol`/`locate_file` return `ChunkSummary`
      (content-free); `expand_chunk` fetches one body by citation. One-shot
      `search_code`/`find_symbol`/`get_file_context` unchanged.
- [x] `related_code` tool: `CodeRetrieval.relatedTo` → `IVectorStore.relatedTo`; citation
      parsed to chunk id; non-boundary citations refused with a corrective error.
- [x] `vectorstore` gains `searchSummaries`/`listSummaries`/`relatedTo` (M3-14/M3-15 store
      primitives) in the same commit; pg and file backends covered; 56 new tests.
- [x] Integration-tested end-to-end via `src/codemcp/integrationtests.sh`; `search_code`,
      `find_symbol`, `get_file_context`, `locate_*`, `expand_chunk`, `related_code` all
      validated against the live index.

**Done when:** codemcp reads through `IVectorStore` + `vectorizer`, one-shot tools produce
identical output, two-tier locate→expand and `related_code` are live, integration tests green.
✅ DONE
  _created 2026-06-15 · updated 2026-06-15 · by Periklis Tzeka_

---

### Prior engine packages (vectorizer / vectorstore / codeindex / mcp / memomcp)

Completed slices of the "split into 5 packages" grooming. All 6 packages done (codemcp above).

### M3-13 · Retrieval Phase 1 — embeddings write-only on reads — `~0.5d` · P2
Phase 1 of **M3-10**. No reader ever consumes `.embedding` off a result: codemcp
`toChunkRow` and memomcp `toRecalled` both drop it; `searchByEmbedding` uses it
*internally* for scoring only. So returning it is dead weight in 100% of call sites —
and it is the single biggest field (a per-row 1024-float vector). Low-risk, universal,
and a prerequisite for the phases below.

- [x] Make `embedding` an **input-only** field: present on the `upsert` record type,
      absent from `SearchHit.record` / `list()` results (`RetrievedRecord = Omit<VectorRecord,
      'embedding'>`). `get(namespace, id)` keeps the full record (re-embed / migrate /
      export — and Phase 3 more-like-this — are the callers that need the vector back).
- [x] pg: dropped `embedding::text` from the read `SELECT`s (it never leaves the DB); file:
      `toRetrieved` strips before return.
- [x] Added the optional defensive `limit?` to `list(namespace, filter?, limit?)` (ALL by
      default); wired into codemcp `find_symbol`/`get_file_context`.
- [x] Tests: read paths ship no `embedding`; `get` still returns it; `list` respects the cap.

**Done when:** `searchByEmbedding`/`list` never carry an embedding, `get` still returns it,
and `list` accepts an optional `limit` — a universal payload cut for codemcp + memomcp. ✅ DONE
(`RetrievedRecord` on `searchByEmbedding`/`list`; pg + file strip the vector; `get` keeps the
full `VectorRecord`; `list` gained `limit?`. vectorstore + codemcp + memomcp build green, tests pass.)
  _created 2026-06-15 · updated 2026-06-15 · by Periklis Tzeka_

### M3-14 · Retrieval Phase 2 — content-free summary tier (two-tier locate→expand) — `~1d` · P2
Phase 2 of **M3-10**; depends on M3-13. A distinct honest type, not a flag on the existing
methods: both consumers already hand-roll the narrowed shape (`RecalledMemory`,
`ChunkRow`-without-body), and a record with `content: ''` would make the type lie.

- [x] `interface VectorSummary { id; namespace; metadata }` (+ `score?` on a `SummaryHit`) and
      `searchSummaries(...)` / `listSummaries(...)` on `IVectorStore`; `get(namespace, id)` is
      the expand. pg selects only summary columns; file strips `content` too.
- [x] **codemcp two-tier tools.** `locate_code`/`locate_symbol`/`locate_file` return content-free
      summaries; `expand_chunk` pulls one body by citation. Additive — the one-shot full path
      (`search_code`/`find_symbol`/`get_file_context`) stays. Integration-tested end-to-end.
- [x] **memomcp recall two-tier.** `recall_locate` (core + top-k archival as content-free
      summaries) → `recall_expand` (full bodies by vectorId) — same `VectorSummary` primitive,
      not a second mechanism. The one-shot `recall` stays.
- [x] Tests: a summary search ships no `content` (pg never selects it / file drops it);
      expand-by-id returns the same body the one-shot path did. (codemcp + memomcp suites.)
- [ ] **Pairs with M3-8/M3-9 streaming** — deferred to those stories; the summary tier is the
      unit they will stream (not a blocker for this story).

**Done when:** codemcp and memomcp retrieve in two tiers — a content-free summary to locate,
then by-id drill-down to expand — via `VectorSummary` + `searchSummaries`/`listSummaries` as
generic primitives both consume, with no body shipped until expand. ✅ DONE (codemcp
`locate_*`/`expand_chunk` + memomcp `recall_locate`/`recall_expand`; both suites green; codemcp
flow validated by `src/codemcp/integrationtests.sh`).
  _created 2026-06-15 · updated 2026-06-15 · by Periklis Tzeka_

### M3-15 (part) · Retrieval Phase 3 — semantic more-like-this primitive — `~0.5d` · P2
First slice of Phase 3 of **M3-10**; depends on M3-13 (`get` keeps the embedding) and M3-14.
The store-level "show me what's related to THIS record" primitive. The remaining
consumer-side relatedness (structural / hybrid / MMR / symbol boost) is tracked open as
**M3-15b** in [BACKLOG.md](BACKLOG.md).

- [x] **Semantic neighbors (more-like-this).** `relatedTo(namespace, id, k, filter?)` on
      `IVectorStore`, excluding the anchor. pg keeps the seed vector server-side via a single
      `WITH seed AS (SELECT embedding …)` CTE (the vector never crosses the wire); file ranks by
      the seed's stored embedding. codemcp `CodeRetrieval.relatedTo` + the `related_code` tool
      expose it (takes a `path:start-end` citation, refuses non-boundary ranges).
- [x] Tests: `relatedTo` excludes the anchor; bad-citation refusal; integration-tested in
      `src/codemcp/integrationtests.sh` (seed excluded, neighbours returned).

**Done when:** a store-level `relatedTo` primitive ranks an anchor's semantic neighbours
(seed excluded, vector never leaving the DB on pg) and codemcp exposes it. ✅ DONE.
  _created 2026-06-15 · updated 2026-06-15 · by Periklis Tzeka_

- [x] **`src/vectorizer`** (leaf, `~1d`) — `EmbedAdapter { modelId, dim,
      embedBatch, embedQuery }` + `createEmbedAdapter(provider, dim)` over
      local/voyage/openai. Deletes the hand-mirrored `LocalQueryEmbedAdapter`
      in `codemcp/src/embed.ts` — one impl, no more "change one, change the
      other." Pure compute, no DB. — done 2026-06-14 (`@agent-local/vectorizer`:
      merged write-side `embedBatch` + read-side `embedQuery` into one adapter
      set; Voyage keeps document/query `input_type`; the duplicate `codemcp/embed.ts`
      is gone. Added the service tier `IVectorService` / `VectorServiceBase` /
      `VectorService.fromProvider` so versions (cached/remote) can swap; codeindex
      and codemcp now depend on `IVectorService`, not the raw adapter. `EmbedProvider`
      union lifted here, no longer duplicated in either config. 7 tests; both
      consumers build green.)
  _created 2026-06-14 · updated 2026-06-14 · by Periklis Tzeka_
- [x] **`src/vectorstore`** (leaf, `~1.5d`) — one copy of
      `DbConnection`/`DbConnectionFactory` (kills the byte-identical dupe across
      `codeindex/db/types.ts` and `codemcp/db/types.ts`), pg + file backends,
      generic `VectorRecord { id, namespace, content, embedding, metadata }` and
      `VectorStore { upsert, searchByEmbedding(ns, emb, k, filter), delete }`.
      `namespace` is opaque; filter is generic equality over `metadata`. — done
      2026-06-14 (`@agent-local/vectorstore`: `IVectorStore` with
      `upsert`/`get`/`searchByEmbedding`/`delete`/`deleteNamespace`/`listNamespaces`/`close`;
      `SearchHit { record, score }` where score is cosine distance. `PgVectorStore`
      (pgvector `<=>` rank + jsonb `@>` equality filter, `ensureSchema`, vector dim
      left UNPINNED per the sharp edge — consumer guards it). `FileVectorStore`
      log-structured: append on upsert, fold-by-id-last-wins on read, rewrite-compact
      on delete; rooted at `data/`, parameterizable `{ baseDir, partitionDir,
      recordsFile }` so `commits/<sha>/chunks.jsonl` and `memories/<ns>/records.jsonl`
      both fit. `DbConnection`/`DbConnectionFactory` + `PgConnectionFactory` now live
      here as the single home — codeindex/codemcp dedupe onto it when they migrate
      (tasks below, still open). The store never learns commit/snapshot. `PgVectorStore`
      takes a connection string OR a ready `DbConnectionFactory` so a pool can be shared
      (also makes SQL marshalling testable). 16 tests: 11 file-backend + 5 pg marshalling
      via a fake connection; leaf builds green, no consumers migrated yet.)
  _created 2026-06-14 · updated 2026-06-14 · by Periklis Tzeka_
- [x] **`src/codeindex` on the engine** (`~1d`) — walker/chunkers/commit
      unchanged; `publish.ts` writes through `vectorstore`, code fields into
      `metadata`. Output stays byte-compatible (`data/commits/<sha>/…`);
      golden-file test guards it. — done 2026-06-14 (depends on
      `@agent-local/vectorstore`: chunks now write through `IVectorStore` with
      `namespace = commitSha`; `FileVectorStore { partitionDir: 'commits',
      recordsFile: 'chunks.jsonl' }` keeps the `data/commits/<sha>/` layout, `pg`
      uses `PgVectorStore` sharing one pool with the commit factory. The duped
      `db/types.ts` + `PgConnectionFactory` now re-export from `vectorstore`; the
      repository collapsed to a commit-metadata + migration journal
      (`CommitRepository`, chunk methods gone), `commit.json` stays a
      codeindex-only sidecar. **Line shape changed** (flat `ChunkRow` → generic
      `VectorRecord`: code fields under `metadata`, new `id`/`namespace`), so
      `codemcp`'s reader must migrate before it can read this index again — see
      "`src/codemcp` on the engine" in BACKLOG.md. Migration 001 dropped its
      `chunks` table (the store owns `vector_records` via `ensureSchema`); the
      per-vector dim guard replaces the old `getEmbeddingDimension` column check.)
  _created 2026-06-14 · updated 2026-06-14 · by Periklis Tzeka_
- [x] **`src/mcp`** (new base/reference, `~1d`) — extract the MCP scaffolding
      that every server re-implements into one shared package so `codemcp` /
      `memomcp` (and future servers) derive from it instead of drifting. Move
      the trio out of `src/agent/src/agent/mcp/`: the **base contract**
      (`mcp.ts` — `Mcp` / `ToolInvoker` / `ToolExecutionResult`), the **actual**
      server (`mcp-client.ts` — `McpClient`, spawned stdio JSON-RPC), and the
      **virtual** server (`local-mcp.ts` — `LocalMcp`, in-process handlers).
      Ships a minimal reference server as the copy-from example; the agent
      imports the contract from here rather than owning it. — done 2026-06-14
      (`@agent-local/mcp`: trio + `ToolDescriptor` split into `tooldescriptor.ts`;
      `TokenUsage` lifted to `@agent-local/common`; every consumer repointed
      directly — no re-export shims; package owns its `src/tests` suite. No
      reference server shipped — deferred to memomcp.)
  _created 2026-06-14 · updated 2026-06-14 · by Periklis Tzeka_
- [x] **`src/memomcp`** (new, `~1.5d`) — standalone `remember`/`recall` server
      over `vectorstore` + `vectorizer`, partitioned by collection; the groom
      reframed M3-7 from "codemcp serves both" to a SEPARATE package (codemcp
      does NOT serve memory). — done 2026-06-15 (`@agent-local/memomcp`: wires
      `FileVectorStore { partitionDir: 'memories', recordsFile: 'records.jsonl' }`
      + `vectorizer`; `MemoryRepository.remember` embeds via `embedBatch`
      (voyage `input_type=document`) and upserts, `recall` loads all `core` by
      exact `list()` + top-k `archival` by `searchByEmbedding` (`embedQuery` →
      `input_type=query`). Flat records, tenant/category in `metadata` as recall
      filters, associations sidecar deferred. **Memory id vs vectorId settled
      2026-06-15**: two entities, `metadata.memoryId` is the memory's own id and
      `vectorId` (= `VectorRecord.id`) is an explicit reference, stable across
      re-embed on overwrite. Per-consumer `assertDim` guard. Tools `remember`/`recall`
      + `probe`/`tools` CLI; registered in `.mcp.json` + workspace; tsc clean,
      7/7 jest green. Manual end-to-end recipe in `src/memomcp/integrationtest.md`
      (ranking, category filter incl. core, overwrite-upsert, voyage paraphrase).
      Follow-ups still open in BACKLOG.md: M3-9 streaming, M3-10 two-tier recall,
      M3-12 persistent/Voyage store. **Not yet committed** — `src/memomcp/` still
      untracked.)
  _created 2026-06-15 · updated 2026-06-15 · by Periklis Tzeka_

---

## M1-4 — Prompt-cache strategy

Completed slices of the prompt-cache milestone; remaining bullets (determinism,
tripwire) stay under M1-4 in [BACKLOG.md](BACKLOG.md).

- [x] Anthropic (`providers/anthropic-provider.ts`): moving breakpoint on the
      LAST content block of the messages array each call — done 2026-06-10
      (`applyMessageBreakpoints`, tests in `tests/anthropic-cache.test.ts`).
  _created 2026-06-10 · updated 2026-06-10 · by Periklis Tzeka_
- [x] Third breakpoint ~15 blocks before the last for the 20-block lookback —
      done 2026-06-10, same change (budget: system 1 + messages 2 = 3 of 4).
  _created 2026-06-10 · updated 2026-06-10 · by Periklis Tzeka_
- [x] Gemini (`providers/gemini-provider.ts`): track `expireTime` from
      `caches.create` and recreate when near expiry — done 2026-06-10
      (`cacheExpiryMs` helper + 30s margin + tests in
      `tests/gemini-cache.test.ts`). Still open: verify the explicit cache
      isn't below flash-lite's minimum-token threshold in practice (if so,
      rely on Gemini 2.5 implicit prefix caching and delete the explicit path).
  _created 2026-06-10 · updated 2026-06-10 · by Periklis Tzeka_
