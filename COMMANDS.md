# ollama serve
# ollama serve &>/tmp/ollama.log &
# ollama pull qwen3-coder:30b-a3b-q4_K_M
# pkill -f "ollama serve"
# ollama pull qwen2.5-coder:14b
# ollama pull deepseek-r1:14b
# ollama pull llama3.2:3b
# ollama pull gemma3:4b
# npm run build
# npm start

# clear all
scripts/clear-codeindex.sh

# Unblock-File .\scripts\publish-codeindex.ps1

powershell -ExecutionPolicy Bypass -File .\scripts\publish-codeindex.ps1 -Repository C:\www\react_sandbox
powershell -ExecutionPolicy Bypass -File .\scripts\publish-codeindex.ps1 -Repository C:/www/Agent.Local
powershell Remove-Item -Recurse -Force .\src\codeindex\data; Remove-Item -Recurse -Force .\src\codemcp\data;
scripts/publish-codeindex.sh -Repository /Applications/www/Agent.Local    
scripts/publish-codeindex.sh -Repository /Applications/www/rxoinc/platform/Rxo.Platform.Web.Sandbox
 

# .\scripts\publish-codeindex.ps1  -Repository C:/www/rxo/platform/Rxo.Platform.Web.Sandbox

npm run start --session 3bd1817e-d563-43b2-a6db-771811411913

npm run start -- --run "create hello_world.txt as background task"
npm run start -- --run "any files in workspace" --session 3bd1817e-d563-43b2-a6db-771811411913
npm run start -- --run "list me files in workspace" --session 3bd1817e-d563-43b2-a6db-771811411913
npm run start -- --run "remove hello_world.txt file as background task" 3bd1817e-d563-43b2-a6db-771811411913
npm run start -- --run "delay as background task for 2 min poll until done" 3bd1817e-d563-43b2-a6db-771811411913

# integ test
powershell -ExecutionPolicy Bypass -File .\scripts\e2e-headless.ps1

# integ memory test
powershell -ExecutionPolicy Bypass -File .\scripts\e2e-memory-headless.ps1

# ── sqlite ──────────────────────────────────────────────────────────────────
# Two DBs, one per process (better-sqlite3, WAL mode):
#   host  -> src/host/data/host.sqlite      (tables: jobs, job_status)
#   agent -> src/agent/data/agent.sqlite    (tables: sessions, conversations, messages, metrics, session_status)
# agent.sqlite is created by db:init; override either path with HOST_DB_FILE / AGENT_DB_FILE.
npm run db:init                         # create/upgrade both DBs to schema

# scripts/db.sh opens either DB in the sqlite3 shell with repo .sqliterc formatting (box mode, headers, timer)
scripts/db.sh host                      # interactive shell on host.sqlite
scripts/db.sh agent                     # interactive shell on agent.sqlite
./scripts/db.sh host "SELECT user_id, status, step FROM jobs ORDER BY updated_at DESC LIMIT 10;"
scripts/db.sh agent "SELECT session_id, status, updated_at FROM sessions ORDER BY updated_at DESC LIMIT 10;"
scripts/db.sh agent "SELECT session_id, json_extract(payload,'\$.goal') AS goal FROM sessions;"

# inside the shell: .tables  .schema [table]  .mode line (expanded)  .quit
# raw sqlite3 (skips .sqliterc): sqlite3 -box src/host/data/host.sqlite "SELECT * FROM jobs;"
# WAL: a reader sees uncommitted rows; to fold -wal back into the file:
scripts/db.sh host "PRAGMA wal_checkpoint(TRUNCATE);"

# ── temporal (standalone workflow-engine server: src/temporalhost) ────────────
# Docker runtime WITHOUT Docker Desktop — pick the per-OS equivalent (both give a real `docker` CLI):
#   macOS   = colima         (Lima Linux VM + daemon)
#   Windows = Rancher Desktop (WSL2 backend, dockerd/moby engine) — colima/Lima do NOT run on Windows
colima start                            # macOS: bring the docker runtime up (once per session)
colima stop                             # macOS: runtime down   | colima status | colima list
brew services start colima              # macOS: optional, auto-start the runtime at login
# Windows: install once — winget install suse.RancherDesktop — then just leave it running (WSL2 required)
#
# temporalhost image = Temporal Server (postgres-backed) on gRPC :7233; UI :8233 (optional).
npm run docker:build -w @agent-local/temporalhost   # build the image (after editing Dockerfile/config)
npm run docker:up    -w @agent-local/temporalhost   # TEARUP:  temporal + postgres (idempotent)
npm run docker:down  -w @agent-local/temporalhost   # TEARDOWN: stop + remove the stack
npm run docker:logs  -w @agent-local/temporalhost   # tail the server log
docker compose -f src/temporalhost/docker-compose.yml ps          # list the stack
docker exec agent-local-temporalhost tctl --address localhost:7233 namespace describe default  # verify namespace
#
# start.sh brings temporal up automatically (idempotent, best-effort); opt out / opt in:
START_TEMPORAL=0 scripts/start.sh       # skip temporal on app start
STOP_TEMPORAL=1  scripts/stop.sh        # also tear temporal down on stop (default: left running)