---
name: debug-work
description: Trace a single work (a.k.a. job) end-to-end by its id — work record + session + temporal join, agent session status, full conversation (orchestrator + executor/sub-session children), workspace contents, agent & host logs, and Temporal/host/agent health. Use when a work reports a wrong status (e.g. "completed" but nothing happened), a step didn't run, a file is missing, or a dispatch misbehaved. All queries and paths are inline and copy-pasteable.
---

# Debug a work by id

End-to-end tracing for one work (a.k.a. job). Run everything from the **repo root**
(`/Applications/WWW/Agent.Local`) — the relative DB paths below assume that cwd.

## Identifier model (read this first)

One run threads through several stores; the ids are equal by value:

```
workId  ==  temporalId (Temporal WorkflowId)
```

- **Host** keys the work by `work_id` in SQLite. The job→work refactor split what used
  to be columns on the job record into joined tables (1:1 per work):
  - `work` — the work unit: `status`, `step` (absorbed the old `statusDescription`),
    `workflow_id`, `workspace_id`, `user_id`, timestamps. PK `(user_id, work_id)`.
  - `work_agent_session` — the session id, with `kind` ∈ {`job`,`cli`}. The
    orchestrator ROOT session for the website is the `kind='job'` row. UNIQUE(work_id, kind).
  - `work_temporal` — the `temporal_id` (room for engine metadata later).
  - `work_status` — the status lookup (label/tone/flags) the console renders from.
- **Agent** keys state by `session_id` in `agent.sqlite`. The conversation is NOT keyed
  by session: `sessions.payload` is JSON holding `conversationId` and `parentSessionId`;
  `messages` are keyed by `conversation_id`. So tracing a session's transcript is a
  two-hop: session → (JSON) conversationId → messages.
- **Sub-runs** (each `executor__dispatch` and each sub-session) are full child sessions:
  `parentSessionId` = the orchestrator session, same `workspaceId`.

> There is no longer an append-only `jobs.jsonl`. The `work` row holds the **current**
> state only; status *transitions* over time are traced in `host.log` (§6), not the DB.

## Paths

| What | Path |
|------|------|
| Agent SQLite (sessions, conversations, messages) | `src/agent/data/agent.sqlite` |
| Host SQLite (work, work_status, work_agent_session, work_temporal) | `src/host/data/host.sqlite` |
| Per-work workspace (generated files land here) | `src/workspace/<workspaceId>/` |
| Auth process log | `scripts/.run/auth.log` |
| Agent process log | `scripts/.run/agent.log` |
| Host process log | `scripts/.run/host.log` |
| PIDs | `scripts/.run/{auth,host,agent}.pid` |
| DB shell helper | `scripts/db.sh host\|agent` (interactive shell) |

> The `sqlite3` CLI **is** installed on this machine — the queries below use it
> directly. (`scripts/db.sh` opens an interactive shell on either DB.) If you ever hit a
> box without it, every query has a `better-sqlite3` equivalent: that module ships in
> the repo's `node_modules`, e.g.
> `node -e 'const db=require("better-sqlite3")("src/host/data/host.sqlite",{readonly:true}); …'`.

---

## 1. Work record (current state + session + temporal join)

One query folds the work row together with its `kind='job'` session and its temporal id —
this is the fastest "what/where/which-session" snapshot. `LIKE '<id>%'` lets you pass a
short prefix. Grab `session_id` and `workspace_id` from the output — the rest keys off them.

```bash
WORKID=<workid>
sqlite3 -header -column src/host/data/host.sqlite "
SELECT w.user_id, w.work_id, w.workflow_id, w.workspace_id, w.status, w.step,
       s.session_id, s.kind, t.temporal_id, w.created_at, w.updated_at
FROM work w
LEFT JOIN work_agent_session s ON s.work_id = w.work_id AND s.kind='job'
LEFT JOIN work_temporal     t ON t.work_id = w.work_id
WHERE w.work_id LIKE '$WORKID%';"
```

A missing `session_id`/`temporal_id` (NULL) means the join row was never written —
the trigger half-provisioned the work (the website enforces exactly one `kind='job'`
session per work, so a NULL here is a real fault, not a normal state).

## 2. Agent session status

```bash
SESSIONID=<sessionid>
sqlite3 -header -column src/agent/data/agent.sqlite "
SELECT status, updated_at,
       json_extract(payload,'\$.workspaceId')      AS workspace,
       json_extract(payload,'\$.conversationId')   AS conv,
       coalesce(json_extract(payload,'\$.parentSessionId'),'ROOT') AS parent
FROM sessions WHERE session_id='$SESSIONID';"
```

List the most recent sessions (to find a root id when you only have a vague time):
```bash
sqlite3 -header -column src/agent/data/agent.sqlite "
SELECT updated_at, session_id, status,
       coalesce(json_extract(payload,'\$.parentSessionId'),'ROOT') AS parent,
       json_extract(payload,'\$.workspaceId') AS ws
FROM sessions ORDER BY updated_at DESC LIMIT 12;"
```

## 3. Conversation (root + all children)

Dumps the orchestrator transcript plus every executor/sub-session child (same parent),
in order. This is where you SEE what each role actually did — e.g. an executor that only
emitted `EXECUTOR: ACK …` with zero tool calls (fabricated, no real work), or an
orchestrator that dispatched a hallucinated tool name. The two-hop join is cleanest in
Node:

```bash
node -e '
const db=require("better-sqlite3")("src/agent/data/agent.sqlite",{readonly:true});
const root=process.argv[1];
const all=db.prepare("SELECT session_id,payload FROM sessions").all().map(r=>({sid:r.session_id,p:JSON.parse(r.payload)}));
const r=all.find(x=>x.sid===root); if(!r){console.error("no session",root);process.exit(1);}
const chain=[r].concat(all.filter(x=>x.p.parentSessionId===root));
for(const {sid,p} of chain){
  console.log("\n===== "+(p.parentSessionId?"CHILD":"ROOT ")+" "+sid+" =====");
  for(const m of db.prepare("SELECT payload FROM messages WHERE conversation_id=? ORDER BY seq").all(p.conversationId)){
    const x=JSON.parse(m.payload); let t=typeof x.content==="string"?x.content:JSON.stringify(x.content);
    if(t&&t.length>900)t=t.slice(0,900)+"…"; console.log("["+(x.role||x.type)+"] "+t);
  }
}' <SESSIONID>
```

## 4. Workspace contents

The acid test for "it said completed but did anything happen?" — an empty dir means no
file was ever written, regardless of reported status. To inspect an `.xlsx` without a
viewer: `unzip -p <file> xl/worksheets/sheet1.xml` (cells), `… xl/workbook.xml` (sheet names).

```bash
ls -la "src/workspace/<WORKSPACEID>/"
```

## 5. Agent logs

Per-turn trace: model calls, tool calls, `executor__dispatch` start/end, sub-session
runtime build, `model response { … toolCalls: N }`. `toolCalls: 0` on an executor turn
is the smoking gun for a no-op dispatch.

```bash
grep -n "<SESSIONID>" scripts/.run/agent.log     # this session's lines
tail -120 scripts/.run/agent.log                  # latest activity
```

## 6. Host logs

Workflow dispatch (`runStep dispatch { … step, prompt }`), `agent.result` republish,
token issuance, and the Temporal worker state. This is also where you read the work's
**status transitions** over time (the DB only keeps the current row).

```bash
grep -n "<WORKID>" scripts/.run/host.log
tail -80 scripts/.run/host.log
```

## 7. Health — host, agent, Temporal

```bash
# processes / ports (auth :3015, host :3011, agent :3020)
cat scripts/.run/{auth,host,agent}.pid 2>/dev/null
curl -s -o /dev/null -w "host  :3011 -> %{http_code}\n" http://localhost:3011/healthz 2>/dev/null
curl -s -o /dev/null -w "agent :3020 -> %{http_code}\n" http://localhost:3020/healthz 2>/dev/null
# composite readiness: BOTH the engine (TCP) AND an authenticated GET to the agent /healthz
curl -s http://localhost:3011/health/ready ; echo

# Temporal: it runs as a Docker container and the host AUTO-SKIPS it when Docker is
# absent (so "no Temporal" can be normal). Confirm the container + the host's connect:
docker ps --filter "name=temporal" --format "{{.Names}}\t{{.Status}}" 2>/dev/null
grep -nE "\[temporal\]|Worker state|taskQueue" scripts/.run/host.log | tail -20
```

Healthy host.log shows `[temporal] connected to Temporal server`,
`Worker state changed { … state: 'RUNNING' }`, and `[temporal] worker polling taskQueue=agent-execute`.

---

## Reading the trace — common diagnoses

- **`/health/ready` says `agent:false` but the agent's `/healthz` is 200 in curl/browser**
  → TLS trust, not an outage. The dev domains (`agentic.peritze.com`, `auth.peritze.com`)
  use an **mkcert** cert that the macOS keychain trusts (so curl/browser pass) but Node's
  bundled CA store does not (`UNABLE_TO_VERIFY_LEAF_SIGNATURE`, surfaced as
  `TypeError: fetch failed`). Fix: `NODE_EXTRA_CA_CERTS` must point at the mkcert root
  (`"$(mkcert -CAROOT)/rootCA.pem"`); `scripts/start.sh` sets this. Same failure shows as
  `bearer verification failed: fetch failed` (JWKS) and breaks real host→agent dispatch too.
- **Status `completed` but workspace empty** → the executor never called a write tool.
  Check §3 children for `EXECUTOR: ACK …` with no following tool call, and §5 for
  `toolCalls: 0` on the executor turn. Completion rides the dispatch round-trip, not
  proof of effect.
- **Executor has only `fsreadonly__*` / `excelreadonly__*` tools** → the `executor` role
  is bound to a read-only model in `models.json` (`roles.executor` → a model whose `mcp`
  lacks `fsmcp`/`excel`). Executor needs the WRITE mounts.
- **Orchestrator dispatched a tool that "does not exist"** → hallucinated tool name; the
  dispatch enum only lists tools the executor actually mounts.
- **Step stuck `running`** → the `dispatchAgentTask` activity fired but the `agentResult`
  signal never landed (round-trip incomplete) — check §6 for the matching `agent.result`.
- **`work` row has NULL `session_id` or `temporal_id`** → the join row in
  `work_agent_session` / `work_temporal` was never written; the trigger only
  half-provisioned the work. Check §6 around the create/trigger for the failure.
