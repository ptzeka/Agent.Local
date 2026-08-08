# Architecture — Agent.Local

*Internal engineering guide. It describes the **target** architecture — what the
system is built toward and what every change is measured against — for the people
building it, not as an outward pitch. It is intentionally not a status report:
where a part is mid-build, the gap lives in [BACKLOG.md](BACKLOG.md), not here.
When the system is built and ready to ship, this doc will be revised to reflect
actual state. Deep dives: [TURN_ROUND.md](TURN_ROUND.md),
[UNIFIED_RUNTIME_PLAN.md](UNIFIED_RUNTIME_PLAN.md),
[REGISTRY_PATTERN.md](REGISTRY_PATTERN.md), [PRODUCTION_READINESS.md](PRODUCTION_READINESS.md).*

---

## What this is and the constraints that shape it

A workflow platform for work that cannot afford improvisation — taxes, filings,
regulated back-office — built on an AI agent core that is **configured, not
coded**. The system has three levels: a **runtime** that executes agent roles, a
**step** that configures what an agent does and how its output is judged, and a
**workflow** that sequences steps into a business process. Each level is
independently configurable and testable; a step can be validated in isolation
before it is wired into a workflow, and a workflow is composed entirely from
already-proven steps.

Four constraints drive the whole design, and the rest of this document is how
each is met structurally rather than by convention:

1. **Build once, then compose by config.** Capabilities (orchestrator, executor,
   evaluator, summarizer) and toolsets (fsmcp, excel, codemcp, bucket) are each
   coded once, role-agnostic. A workflow step is then an agent *role* — a model,
   a mounted toolset, a direction, an evaluator — assembled from that library by
   config. A new step like a KYC document reviewer is config when the parts it
   needs already exist; code is only written to add a capability or toolset the
   library is still missing. The value compounds as the library fills — steps
   reused across workflows, workflows reused across products.
2. **The agent composes within a step; the workflow sequences steps.** The LLM
   figures out how to use the available tools to satisfy the step's goal — you
   configure the surface and the acceptance criteria, not the execution path.
   Workflow config handles what happens next: retry, branch, escalate, HITL.
   Neither level writes imperative logic.
3. **What a role may touch is decided by who is running it, deterministically.**
   Access resolves from verified identity claims and is enforced before a tool is
   reachable — never requested in a prompt, never left to the model.
4. **Every state change must be provable.** Mutations flow through one gateway
   with an isolated, replayable session trail. The bucket is workspace-scoped so
   a session is structurally incapable of reaching another session's files. The
   audit record shows what the agent did, what memory and examples were active,
   what the evaluator accepted, and what the workflow did next.

A fifth, cross-cutting concern: sensitive steps run on local models so data never
leaves the machine, while judgment-heavy steps use cloud models — per role, per
user, per workflow.

---

## How it works, in one read

There is **one** `AgentRuntime`. It serves every shape the system runs in — an
interactive CLI chat, a headless workflow step, an executor child spawned to
perform a mutation, a role-agent child answering one ask — and the only thing that differs
between them is which steps are stacked in its build pipeline and which **role**
it runs.

A role is pure config: model, mounted toolset, prompt — managed through the
configuration console. A **step** wraps a role with the context it needs to do
its job — a direction, grounding examples, active memory, and an evaluator that
judges the output. A **workflow** sequences steps, declares what gets passed
between them via the workspace bucket, and defines what happens when a step
fails: retry, branch, raise a human.

The agent within a step is not scripted. It receives the available tools and the
goal, and it determines the path. The evaluator judges the output against declared
criteria — required fields present, values reconcile, document reference matches
source — not the path taken. What the workflow proves is the output, not the
procedure.

Privilege is separated **structurally, not by instruction**. A role can call only
the servers its `mcp` whitelist names, so an inspection role mounts `fsreadonly`
and simply has no write tool to reach for — the constraint is the absence of the
capability, not a rule it was told to follow. The workspace bucket is hard-scoped to the session's workspace
id — a step cannot reach another workflow's files. Identity rides every child
unchanged, so one access check covers every nesting level.

---

## Why this shape pays off at scale

With three toolsets the indirection here looks like over-engineering. It is not
built for three — it is built for the case where the library holds hundreds of
toolsets and many capabilities, and composition is the only thing that stays
tractable. The structural choices are the up-front cost paid now, while the
ecosystem is thin, to earn the mix-and-match payoff once it is dense:

- **The neutral `Mcp` interface** means toolset #200 mounts exactly like toolset
  #2 — no runtime change, no special-casing. Adding capability is linear effort,
  not combinatorial.
- **Config-driven whitelists** keep "mix and match" survivable at scale: a role
  selects its surface from the configuration framework, so the per-role × per-server
  matrix is data, not branches in code.
- **Deterministic access stays cheap to reason about.** `model whitelist ∩ user
  policy` at mount holds whether there are 3 servers or 300 — there is no growing
  pile of imperative checks to audit.
- **Local/cloud per role** matters more as the library grows: a sensitive toolset
  can be pinned to a local model while everything else stays on cloud judgment.

This is the difference between a tool *integration* and a tool *ecosystem*:
integrations are coded each time and scale linearly in effort; an ecosystem
absorbs new pieces by config, and the composition value grows as the library fills.

---

## The three layers

```
Workflow    sequencing, branching, retry policy, HITL
Step        role, tools, direction, evaluator, memory, examples
Runtime     AgentRuntime, runners, registries, MCP, bucket
```

Each layer is configured independently. The runtime executes whatever role it is
given; it knows nothing of steps or workflows. A step knows nothing of the
workflow that contains it — it receives a goal, tools, and context, and produces
a pass/fail result with an output artifact. The workflow knows nothing of how a
step does its work — it routes on the result.

This separation is what makes the library compound: a "validate excel against
schema" step is written once and dropped into any workflow that needs it. A
workflow that handles KYC today reuses the same document-validation step as one
that handles AML tomorrow.

---

## Model abstraction

Every agent role runs through a single `LLMProvider` interface. The model that
backs a role is a config entry in the configuration console — not a code
dependency, not a hardcoded default. Swapping a role from one model to another is
a console change with no downstream effect on the step, the workflow, or the
runtime.

**What this enables in practice:**

- **Best model for the job.** A judgment-heavy step (summarisation, ambiguous
  document interpretation) runs on a frontier cloud model. A structured extraction
  step (pull these fields, fill this template) runs on a smaller, faster, cheaper
  model. A sensitive step that must not leave the machine runs on a local model.
  These are independent decisions, made per role, per step, per workflow.
- **On-premise / air-gapped deployment.** Any role can be pointed at a locally
  hosted model (Ollama or equivalent) with no change to the runtime or step config
  beyond the model assignment. A fully on-prem deployment is a config profile, not
  a separate codebase.
- **Cost and latency control.** High-volume, low-complexity steps are routed to
  cheaper models. The console makes the model assignment visible per step so
  operators can tune cost/quality tradeoffs without touching workflow logic.
- **Model portability.** No step or workflow is coupled to a specific provider.
  When a better model is available — or a current one is deprecated — the
  assignment is updated in the console and all workflows using that role pick it
  up immediately.

**How it works.** The `ProvidersRegistry` instantiates one `LLMProvider` per
role-referenced model (Anthropic, Gemini, Ollama behind a single interface). The
`ModelRegistry` maps each role to its assigned model. A role that lacks native
tool-calling support gets a prompted-JSON fallback automatically — the toolset
surface is identical to the runtime regardless of model capability. The step and
workflow layers never see the model directly; they interact with the role, and the
role resolves to whatever model is currently assigned in the configuration
framework.

**Model assignment is part of step config.** When a step is configured in the
console, the operator selects:

- The model (cloud provider + model name, or local endpoint)
- Whether the step is data-sensitive — if so, the console enforces a local-only
  model assignment and will not accept a cloud model for that step
- The fallback model if the primary is unavailable (optional, for resilience)

**Data residency as a hard constraint, not a guideline.** For steps handling
regulated or sensitive data, the model assignment is not a preference — it is a
policy. The console enforces local-only at config time for steps marked sensitive;
the runtime enforces it at execution time by resolving only to the assigned
provider. There is no prompt, no override, no fallback to cloud. The audit record
includes the model and provider that ran each step, so data residency is provable
after the fact as well as enforced before it.

---

## Workflow

A workflow is an ordered composition of steps with declared routing between them.
It is the only place that business-process logic lives — sequencing, branching,
retry, and human escalation are workflow concerns, not step or runtime concerns.

**Structure.** A workflow config declares:

- The ordered list of steps, each referenced by name
- The workspace bucket layout — which folders steps read from and write to, by
  convention (`/in-progress/{session-id}/`, `/done/{session-id}/`)
- Per-step retry policy — max attempts, what counts as a retryable failure
  (evaluator reject vs hard tool error vs timeout), backoff
- Branching — on pass go to step N, on hard fail go to step M or terminal
- HITL points — which failure modes pause execution, what context is surfaced to
  the operator, which step resumes after unblock

**HITL is a native step type, not a special case.** When a step exhausts its
retry budget, the workflow raises a HITL event: execution pauses, the operator
sees the session, the bucket state, the evaluator's rejection reason, and the
active memory for that step. The operator can edit the file directly, add a
memory note to correct the agent's behaviour on retry, or override and continue.
After unblock the workflow resumes from the declared resume point — re-running the
failed step against the corrected artifact, or continuing to the next step.

**The bucket is the handoff medium between steps.** A step's output is a file (or
files) written to the workspace bucket. The next step downloads what it needs.
This makes the inter-step contract explicit and auditable — the bucket state at
any point in a workflow run is a complete record of what has been produced.

**Bucket versioning by step.** Files are written with a step-counter prefix
(`/in-progress/{session-id}/step-02/report.xlsx`) so that a retry or HITL
correction produces a new version rather than overwriting. The workflow config
declares which version a resuming step reads — the latest, or a specific one. This
makes retry and HITL correction unambiguous and the audit trail self-describing.

---

## Step

A step is the unit of agent work. It configures everything the agent needs to do
its job and everything needed to judge whether it has done it.

**A step is not a script.** The direction tells the agent what to produce, not how
to produce it. The agent uses the available tools to satisfy the goal; the
evaluator judges the output. You configure the surface and the acceptance
criteria — the agent composes the path.

**Step config declares:**

- **Role** — which agent role runs this step (model assigned in the console,
  mounted toolset)
- **Direction** — the goal, in natural language, precise enough that the
  evaluator criteria are satisfiable. "Create an excel with required fields
  populated from customer data" not "call get_customer then write_row."
- **Tools** — the toolset mounted for this step (bucket read/write, CRM lookup,
  excel, external APIs). The role's server whitelist intersected with the user's
  policy determines what is actually reachable.
- **Context** — workspace id, session metadata, business rules in scope
- **Examples** — vectorized few-shot examples of correct outputs for this step,
  retrieved at run time. Ground the model on the expected shape without scripting
  the path.
- **Memory** — the active standing instructions for this step (see Memory below)
- **Evaluator** — the acceptance criteria and the evaluator kind:
  - *Deterministic* for regulated steps: required fields present, values in range,
    document reference matches source record. Hard pass/fail, auditable.
  - *LLM* for judgment steps: coherence, completeness, tone. Fail-open acceptable.
- **Retry policy** — inherited from workflow config, overridable per step

**The evaluator is output-facing, not process-facing.** It does not care how the
excel was built — only whether the result meets spec. For a regulated context this
is the right audit claim: "these fields were present and valid at this point in
time," provable independently of the agent's execution path.

**Step interface.** A step exposes three things to the workflow that contains it:

- **Expected inputs** — what it expects to find in the bucket or session context
  before it runs
- **Guaranteed outputs** — what it writes to the bucket on pass
- **Failure modes** — evaluator reject (retryable), hard tool error (may not be
  retryable), timeout

Declaring the interface lets the console validate at composition time that step
N's expected inputs are covered by step N-1's guaranteed outputs. Mismatches are
caught in config, not at runtime.

---

## Memory and examples

Memory and examples are the two mechanisms that ground an agent in institutional
knowledge without hardcoding behaviour into the direction or the evaluator.

**Examples** are vectorized representations of correct past outputs for a step.
At run time, the most relevant examples for the current input are retrieved and
injected into the step context alongside the direction. They answer the question
the direction cannot: "here is what a correctly filled KYC excel looked like for a
similar customer." Examples are generated from past runs that passed the evaluator
and are managed per step in the console.

**Memory** is the set of standing operator instructions for a step, active across
all runs. It is closer to an evolving system prompt than a retrieval index —
persistent rules the agent must follow regardless of input. "For this step always
derive field X from source Y." "If the customer is a corporate entity use template
B." "Never leave column Z blank — use the default value if source is null."

Memory is:

- **Written and updated by operators** via the console, not by the agent
- **Versioned** — each run records which memory snapshot was active, so the audit
  trail is complete: direction + examples + memory version + evaluator result
- **Injected at step context assembly**, alongside direction and examples, before
  the agent runs
- **Scoped to the step** — memory for the KYC fill step does not bleed into the
  document validation step

**Correction without reconfiguration.** When a step produces the wrong output
consistently, the operator adds a memory note rather than touching the workflow
config or the evaluator. The agent corrects; the workflow stays stable. This is
the primary operational tuning loop and it is intentionally low-friction.

**Memory drift.** Accumulated notes can contradict each other or silently override
the original direction. The console surfaces active memory entries prominently per
step — count, last updated, full text — and prompts periodic review. Memory is an
operational asset that requires the same maintenance as any other part of a
running system.

**Access control.** Examples and memory are both workspace-scoped. A step cannot
retrieve examples from another workspace's runs via the vector index, and memory
is keyed per step per workflow. The isolation model that applies to the bucket
applies equally here.

---

## Layering

Four layers, each calling only downward. A layer never reaches across or upward.

- **UI / Hosts** — `cli/` (REPL, render, headless). Input and display only; owns
  the root cancellation signal for a request and hands it down.
- **Services** — `runners/`, `runtime/`, `session/`. Orchestration, turn
  scheduling, and run state. Runners obtain every dependency through
  `AgentRuntimeQueryable` getters — never by importing a lower layer directly.
- **Repository / External** — `registries/`, `mcp/`, `synthetic-mcp/`,
  `providers/`, the session and conversation stores. Lookups, transport, model
  SDKs, persistence.

The rule is mechanical, not aspirational: a runner that needs a provider, a tool
surface, or the store asks the runtime for it. The composition of lower layers is
the runtime's job alone, which is what keeps the dependency direction one-way and
testable.

The one boundary that is **mechanically fenced** is `runners/**` importing lower
layers directly (`registries/`, `synthetic-mcp/`, `mcp-client`,
`scoped-tool-client`): a lint rule (`no-restricted-imports`) — or, failing that, a
CI architecture test that greps imports — fails the build on violation, because
the stateless-runner design collapses the moment a runner reaches sideways instead
of through `AgentRuntimeQueryable`. The rest of the layering is convention, as in
any system; only the seam whose violation would silently rot the design is
enforced by tooling.

---

## AgentRuntime and the build pipeline

[agent-runtime.ts](src/agent/src/agent/runtime/agent-runtime.ts) is the stateful
owner of exactly **one** session. Its `build()` constructs nothing directly: each
subsystem is produced by a pipeline step that writes its result into a shared
`RuntimeContext`. `build()` then verifies every owned field was produced and
reports all missing steps at once, so a misconfigured runtime fails loudly at
construction rather than mysteriously at call time.

The pipeline exists to make construction **ordered, swappable, and inspectable**.
A child runtime is the same pipeline with three steps swapped — one codepath, not
a second.

| Step ([middleware/](src/agent/src/agent/runtime/middleware/)) | Produces |
|---|---|
| `logger` | Logger |
| `configuration` | ConfigurationRegistry — loads runtime configuration from the configuration framework, owns the `OrchestrationConfig` limits |
| `providers` / `models` | ProvidersRegistry (one `LLMProvider` per role-referenced model) / ModelRegistry (role → model, per-model server whitelist, prompts) |
| `store` / `workspace-registry` | SessionStore / WorkspaceRegistry |
| `identity` → `anonymous` | Principal — JWT verification with anonymous fallback when no credential is presented |
| `session` | open or resume the Session, stamped with the resolved `user` |
| `conversation` | the transcript, backed by ConversationStore (its own file, separate from session state) |
| `mcp-registry` | McpClientRegistry with the in-process LocalMcps mounted |
| `connect-mcp-servers` | external stdio servers from `mcp.json`, mounted behind the same neutral registry |
| `orchestrator` | the one stateless Orchestrator runner |
| `context` | the hashed, per-role context snapshot |
| `input-inbox` | InputInbox — the pull seam out-of-band producers queue prompts through |

**Child variant** ([build-sub-runtime.ts](src/agent/src/agent/runtime/build-sub-runtime.ts)) —
the executor and the role-agents run this. Two steps change:
`identity`+`anonymous` become `inherited-user` (the child adopts the parent's
verified `user` rather than re-authenticating), and `session` becomes
`child-session` (a fresh, parent-linked session). Nesting is bounded upstream
instead: a dispatchable role mounts no agents of its own, so a chain is at most
coordinator → agent.

---

## Registries

Registries are deliberately **dumb lookups** ([registries/](src/agent/src/agent/registries/)):
they resolve a resource by name and nothing more. Composition is the consumer's
job. Config is consistent **by contract** — validating that a role names a real
model and a coherent toolset belongs to the **configuration framework**, upstream
of the runtime, so the runtime stays a thin, fast resolver. The configuration
console is the authoritative producer: it manages which model serves each role,
which toolsets it mounts, and which steps run locally for data that must not leave
the machine. The runtime receives valid, resolved config and does dumb lookups
against it.

- **ConfigurationRegistry** — the single reader of runtime configuration. Loads
  it once, merges the `orchestration` block over defaults, caches the result. Owns
  the run limits: iteration caps, per-turn dispatch caps, summarization thresholds.
- **ProvidersRegistry** — instantiates one `LLMProvider` per role-referenced model
  (Ollama / Anthropic / Gemini behind a single interface; a prompted-JSON tool
  fallback hardens models without native tool calling).
- **ModelRegistry** — the heart of per-role privilege: role → model (as assigned
  in the configuration console), each model's MCP server whitelist
  (`getValidMcpForModel`), and the role prompt. Roles hot-swap at runtime
  (`assignRole`).
- **McpClientRegistry** — neutral transport: register / getClient / listTools. It
  knows nothing of roles or turns.
- **WorkspaceRegistry** — workspace id → root + project context (`agentcontext.md`),
  loaded once and shared across sessions on the same workspace.

---

## Tools: one interface, three kinds

The [`Mcp`](src/agent/src/agent/mcp/mcp.ts) contract (`listTools` / `callTool`)
makes every tool source interchangeable to the runtime:

- **LocalMcp** — in-process toolsets dispatched as plain function calls (fsmcp,
  excel, delaymcp, turnresult). A toolset + a server name + a whitelist
  entry is a complete new capability — no new runtime code.
- **McpClient** — external stdio servers (e.g. codemcp), mounted from `mcp.json`
  behind the same registry as the local ones.
- **RoleDispatchLocalMcp** ([synthetic-mcp/role-dispatch-server.ts](src/agent/src/agent/synthetic-mcp/role-dispatch-server.ts))
  — delegation as a tool. Each role named in a caller's `agents` list mounts as
  `<role>__ask`, and one call spawns a **brand-new child runtime** (own session,
  conversation, persistence, registries) for that role, bounded by a
  DispatchTracker per-turn cap. The role's declared `returns` becomes the tool's
  `outputSchema`, so the MCP client gates the answer's shape and no tool body
  re-checks it. The child's token usage returns on `ToolExecutionResult.usage`
  and folds into the parent's tally, so delegated cost is accounted through the
  ordinary tool result, not a side channel.

`ScopedToolClient` is the single dispatch front per role: it fronts the servers
that role resolved to, routes `<server>__<tool>` calls, clamps every fsmcp path to
the workspace root, and emits tool-call / tool-result events centrally.

The read/write boundary is **server-level and structural**: a role that should not
write mounts the read-only server (`fsreadonly`, `excelreadonly`) instead of the
mutating one (`fsmcp`, `excel`). A role cannot reach a write tool it was never
mounted — there is no name-based classifier to fool and no per-tool deny list to
keep in sync. Delegation is a separate axis: `mcp` grants a role tools it calls
itself, `agents` grants it other roles to hand a sub-goal to. Neither implies the
other, so a role may write directly, delegate, both, or neither.

---

## Runners

Runners are stateless logic over runtime-provided state
([runners/](src/agent/src/agent/runners/)). One implementation serves every role.

- **Orchestrator** — the model loop: ask the model → run its tool calls → check
  the completion gate → repeat, until satisfied or capped. One instance per
  runtime, any role.
- **Evaluator** — the completion gate, **pluggable per step**. It decides whether
  a step's goal is met, and what kind of judge it is is a config choice, not a
  fixed LLM. A regulated step attaches a *deterministic* evaluator — required
  fields present, totals reconcile — giving a hard, auditable pass/fail that
  cannot fail open. A soft step uses an *LLM* evaluator on its own configured
  model, where failing open on a flaky judge is an acceptable UX default.
- **Summarizer** — transcript folding, both threshold-triggered and manual
  (`/compact`), with provider-safe tail boundaries.
- **TurnRunner** — the session's single-writer scheduler (see below). Makes
  multi-producer input race-free **by construction**.
- **InputInbox** — steering *inside* a live round; drained at the start of each
  orchestrator iteration. One level below a round.
- **Role-agent** — a dispatchable role mounted as `<role>__ask`: one call runs
  it as a fresh child and returns an answer gated by the role's declared
  `returns`. Blocking, so the round that asked is the join; a reply's calls fan
  out with `Promise.all`, so N agents run at once and all land together.

---

## Turns and rounds: the scheduling core

`dispatchAsync` is single-flight — it refuses to run while the session is already
running. That guard is correct but fragile the moment several producers can start
work: the user typing, an out-of-band producer, a future API call. The
**TurnRunner** removes that race structurally rather than defensively — every
producer *enqueues*, and exactly one pump loop is ever the caller of
`dispatchAsync`. Full detail in [TURN_ROUND.md](TURN_ROUND.md).

Four nested levels, coarse to fine:

- **Turn** — one engagement with the session (a user request, an injected
  prompt, a future API call). FIFO queue; one pump consumes it.
- **Round** — one `dispatchAsync` within a turn. Bounded by `maxRoundsPerTurn`
  (default 8), which caps any settle → react → spawn feedback loop by spilling
  excess into a fresh queued turn.
- **Iteration** — the orchestrator's internal model loop (ask → tools →
  evaluator gate), bounded by the role's iteration cap.

Input lands by deterministic, synchronous placement: a mid-turn round (input that
belongs to the work in flight) → a coalesced round (don't grow the queue with
duplicates) → a new turn. The caller always receives a `settled` promise that
resolves with the turn's final snapshot and **never rejects** — errors live inside
the snapshot. An injected prompt therefore either joins the live engagement as a
round, or wakes an idle session into a fresh turn that answers unprompted. The
data model is plain serializable records throughout — the seam that lets the
scheduler become durable (see Scaling).

---

## State and persistence

- **Session** — run state: status, counters (including delegated usage from
  executor children), links (`parentSessionId`, `conversationId`), and the
  stamped `user`.
- **Conversation** — the transcript, in its own store and file, separate from
  session state. Reset is a soft delete (the audit file is kept); `/compact`
  replaces it with a summary checkpoint.
- **SessionStore** — the store is keyed by **user id**: a session is addressed as
  `load(userSub, sessionId)`, with the user id part of the lookup key, never a
  post-load filter. This makes per-user isolation a property of how data is
  reached, not a check that can be forgotten.
- **Context snapshots** — content-addressed per role (`session.contextHashes[role]`).
  Prompts and context come **only** from this snapshot — runners never assemble
  context from constants — which is what makes a run auditable and replayable.

---

## Identity and access control

Access is decided by **verified identity, deterministically, before a tool is
reachable** — never by the model and never inside a prompt.

- **Identity** — a request carries a JWT, verified against the issuer's JWKS
  (signature, issuer, audience, expiry). The decoded `Principal` carries the
  user's `sub`, scopes, and claims. A request with no credential resolves to the
  anonymous principal, which carries the minimum surface.
- **Session ownership** — because sessions are stored under the user id, and
  resume binds `session.user.sub` to the resolving principal, one principal
  cannot resume another's session.
- **Capability resolution** — a role's reachable tool surface is
  `resolveAllowedTools` = the model's server whitelist **∩** the user's policy
  (`policies.json`, resolved per principal from their claims), at **server**
  granularity. This intersection is enforced at **mount time**: a server outside
  the intersection is never mounted, so it is absent from both what the model is
  shown and what dispatch can reach — advertisement and enforcement are the same
  artifact and cannot drift.
- **One check, every level** — `session.user` is inherited by every child runtime
  (`inherited-user`), so the same deterministic intersection applies at the
  orchestrator, at the executor it dispatches, and at any role-agent — written
  once, uniform at every nesting depth.
- **Mutation audit** — every state change runs through the executor gateway with
  its own session trail, recording who, which session, which tool, and with what
  arguments.

The throughline: a read-only user is structurally incapable of reaching a write
server — not advised against it, not filtered out of the prompt, but never mounted
the capability in the first place.

---

## Scaling: from CLI to service

The runtime is host-agnostic by design: the same `AgentRuntime` and the same
runners drive a CLI today and a multi-process service later. The seam that makes
that possible is the **TurnStore** — the TurnRunner is two halves wearing one coat:

- the **queue** half (pending turn/round records) is plain serializable data and
  can live in a durable store;
- the **live** half (the running turn: pump, mid-turn append, abort chains,
  parent/child settlement) must stay in memory on the owning process.

Going durable is therefore a swap of the queue's endpoints only —
`claimNext` / `append` / `settle` behind a `TurnStore` interface, in-memory for
the CLI host, a durable backend for a cloud host — while the pump is untouched.
It **shards cleanly** because the session is already the consistency boundary
(zero cross-session transactions): `sessionId` is the shard key, and the owning
process's `runtime_id` lease is the fencing token that enforces
single-writer-per-session across the cluster. Steady state never polls — the
owning process holds the session live and `submit()` kicks the in-memory pump; the
claim query runs only on the cold paths, placement and failover. Full design in
[TURN_ROUND.md §10](TURN_ROUND.md).

---

## Where work continues

External MCP remount, policies.json enforcement, real JWT verification,
orchestrator decomposition (MR-4), turn-snapshot persistence, service mode,
configuration console, workflow and step schema design, bucket tool, memory and
vector store. Tracked in [BACKLOG.md](BACKLOG.md) and
[PRODUCTION_READINESS.md](PRODUCTION_READINESS.md).
