---
name: debug-work
description: Trace a single work/job end-to-end by its id — job record + status history, session status, full conversation (orchestrator + executor/sub-session children), workspace contents, agent & host logs, and Temporal/host/agent health. Use when a work reports a wrong status (e.g. "completed" but nothing happened), a step didn't run, a file is missing, or a dispatch misbehaved. All queries and paths are inline and copy-pasteable.
---

# Debug a work by id

End-to-end tracing for one work (a.k.a. job). Run everything from the **repo root**
(`c:\www\Agent.Local`) — the relative DB paths below assume that cwd.

## Identifier model (read this first)

One run threads through three stores under three different keys — they are equal by value:

```
workId  ==  jobId  ==  temporalId (Temporal WorkflowId)
```

- **Host** keys the job by `jobId` and records `sessionId` (the orchestrator ROOT
  session) + `workspaceId`.
- **Agent** keys state by `session_id`. The conversation is NOT keyed by session:
  `sessions.payload` is JSON holding `conversationId` and `parentSessionId`;
  `messages` are keyed by `conversation_id`. So tracing a session's transcript is a
  two-hop: session → (JSON) conversationId → messages.
- **Sub-runs** (each `executor__dispatch` and each sub-session) are full child
  sessions: `parentSessionId` = the orchestrator session, same `workspaceId`.

## Paths

| What | Path |
|------|------|
| Agent SQLite (sessions, conversations, messages) | `src/agent/data/agent.sqlite` |
| Host job records (append-only log) | `src/host/jobs/jobs.jsonl` |
| Host SQLite (jobs, job_status) | `src/host/data/host.sqlite` |
| Per-work workspace (generated files land here) | `src/workspace/<workspaceId>/` |
| Agent process log | `scripts/.run/agent.log` |
| Host process log | `scripts/.run/host.log` |
| PIDs | `scripts/.run/agent.pid`, `scripts/.run/host.pid` |
| DB shell helper | `scripts/db.sh host\|agent "<sql>"` |

> **Gotcha:** `scripts/db.sh` calls the `sqlite3` CLI, which is **not installed** on
> this machine (`exec: sqlite3: not found`). Use the Node/`better-sqlite3` one-liners
> below instead — that module ships in the repo's `node_modules`. (If you later
> install a real `sqlite3` CLI, `db.sh` works as designed.)

---

## 1. Job record + status history

The jsonl is append-only, so every status transition for the work is one line — this
is the fastest way to see `new → running → completed/stopped` and the
`statusDescription`.

```bash
grep '"<WORKID>"' src/host/jobs/jobs.jsonl \
  | node -e 'const ls=require("fs").readFileSync(0,"utf8").trim().split("\n");for(const l of ls){const j=JSON.parse(l);console.log(j.ts+"  "+j.status.padEnd(10)+"  ws="+(j.workspaceId||"-")+"  sess="+(j.sessionId||"-")+"  "+(j.statusDescription||""));}'
```

Grab the `sessionId` and `workspaceId` from the last line — the rest of the trace keys off them.

If the host moved to SQLite, the same via the agent-DB helper pattern:
```bash
node -e 'const db=require("better-sqlite3")("src/host/data/host.sqlite",{readonly:true});for(const r of db.prepare("SELECT ts,status,workspaceId,sessionId,statusDescription FROM jobs WHERE jobId=? ORDER BY ts").all(process.argv[1]))console.log(r.ts,r.status,r.workspaceId,r.sessionId,r.statusDescription);' <WORKID>
```

## 2. Session status

```bash
node -e 'const db=require("better-sqlite3")("src/agent/data/agent.sqlite",{readonly:true});const s=db.prepare("SELECT status,payload,updated_at FROM sessions WHERE session_id=?").get(process.argv[1]);if(!s){console.error("no session");process.exit(1);}const p=JSON.parse(s.payload);console.log("status   :",s.status);console.log("updated  :",s.updated_at);console.log("workspace:",p.workspaceId);console.log("convId   :",p.conversationId);console.log("parent   :",p.parentSessionId||"ROOT");' <SESSIONID>
```

List the most recent sessions (to find a root id when you only have a vague time):
```bash
node -e 'const db=require("better-sqlite3")("src/agent/data/agent.sqlite",{readonly:true});for(const r of db.prepare("SELECT session_id,payload,status,updated_at FROM sessions ORDER BY updated_at DESC LIMIT 12").all()){const p=JSON.parse(r.payload);console.log(r.updated_at+"  "+r.session_id+"  "+r.status.padEnd(14)+"  parent="+(p.parentSessionId||"ROOT")+"  ws="+p.workspaceId);}'
```

## 3. Conversation (root + all children)

Dumps the orchestrator transcript plus every executor/sub-session child (same parent),
in order. This is where you SEE what each role actually did — e.g. an executor that
only emitted `EXECUTOR: ACK …` with zero tool calls (fabricated, no real work), or an
orchestrator that dispatched a hallucinated tool name.

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
file was ever written, regardless of reported status.

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

Workflow dispatch (`runStep dispatch { … step, prompt }`), `agent.result`
republish, token issuance, and the Temporal worker state.

```bash
grep -n "<WORKID>" scripts/.run/host.log
tail -80 scripts/.run/host.log
```

## 7. Health — host, agent, Temporal

```bash
# processes / ports (host :3011, agent :3020)
cat scripts/.run/host.pid scripts/.run/agent.pid 2>/dev/null
curl -s -o /dev/null -w "host  :3011 -> %{http_code}\n" http://localhost:3011/ 2>/dev/null
curl -s -o /dev/null -w "agent :3020 -> %{http_code}\n" http://localhost:3020/ 2>/dev/null

# Temporal: it runs as a Docker container and the host AUTO-SKIPS it when Docker is
# absent (so "no Temporal" can be normal). Confirm the container + the host's connect:
docker ps --filter "name=temporal" --format "{{.Names}}\t{{.Status}}" 2>/dev/null
grep -nE "\[temporal\]|Worker state|taskQueue" scripts/.run/host.log | tail -20
```

Healthy host.log shows `[temporal] connected to Temporal server`,
`Worker state changed { … state: 'RUNNING' }`, and `[temporal] worker polling taskQueue=agent-execute`.

---

## Reading the trace — common diagnoses

- **Status `completed` but workspace empty** → the executor never called a write tool.
  Check §3 children for `EXECUTOR: ACK …` with no following tool call, and §5 for
  `toolCalls: 0` on the executor turn. Completion rides the dispatch round-trip, not
  proof of effect.
- **Executor has only `fsreadonly__*` / `excelreadonly__*` tools** → the `executor`
  role is bound to a read-only model in `models.json` (`roles.executor` → a model whose
  `mcp` lacks `fsmcp`/`excel`). Executor needs the WRITE mounts.
- **Orchestrator dispatched a tool that "does not exist"** → hallucinated tool name; the
  dispatch enum only lists tools the executor actually mounts.
- **Step stuck `running`** → the `dispatchAgentTask` activity fired but the `agentResult`
  signal never landed (round-trip incomplete) — check §6 for the matching `agent.result`.
