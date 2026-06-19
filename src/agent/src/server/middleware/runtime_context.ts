import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import type { Request, Response, NextFunction, RequestHandler } from "express";
import { buildRuntime, type AgentRuntime, type AgentRuntimeDeps } from "../../runtime.js";

// the work unit's session id, sent by the host on every call; selects which runtime/session serves the request
export const SESSION_HEADER = "x-session-id";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      agentRuntime: AgentRuntime;
      // the session this request resolved to (the runtime is built bound to it); handlers read it here
      // instead of digging it back out of req.agentRuntime.getSession()
      sessionId: string;
      // the runtime's parent (process root) signal, so a handler's turn cancels on shutdown
      runtimeSignal: AbortSignal;
      // drains and releases this request's runtime (MCP clients close, session flushes); the handler
      // calls it once its work is done, since the runtime lives only for the request that built it
      closeRuntime(): Promise<void>;
    }
  }
}

export interface RuntimeContextDeps {
  // the one input not resolvable from the request: the process root signal that every runtime's
  // parentSignal (and so every turn's cancellation) derives from. Config, logger and bus are read off req
  // — that is the point of config_context/logger_context/eventing_context, so they aren't re-passed here.
  signal: AbortSignal;
}

// walk up to the workspace root (the dir holding mcp.json) — the same anchor the CLI bootstrap uses
function findProjectRoot(): string {
  let cursor = path.resolve(url.fileURLToPath(new URL(".", import.meta.url)));
  for (;;) {
    if (fs.existsSync(path.join(cursor, "mcp.json"))) return cursor;
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new Error("runtime_context: could not locate mcp.json above the server");
    cursor = parent;
  }
}

// resolves the session a request runs under, and thus which runtime serves it (one runtime == one session,
// the id IS the key). Purely the X-Session-Id the host sends — the work unit's minted sessionId; identity is
// enforced separately in userContext. Absent the header, all callers share the single "anonymous" session.
function resolveSessionId(req: Request): string {
  return req.header(SESSION_HEADER)?.trim() || "anonymous";
}

// builds the runtime for ONE request, bound to its resolved session and reading config/logger/bus off the
// req the upstream context middleware resolved. Paths are env-overridable; streamOutput stays off (no TTY)
// — the server collects the final answer and reports it as agent.result.
function buildForRequest(req: Request, signal: AbortSignal, sessionId: string): Promise<AgentRuntime> {
  const { workspace, sessionsDir: configuredSessionsDir } = req.serverConfig;
  const projectRoot = findProjectRoot();
  const sandboxRoot = path.resolve(
    projectRoot,
    workspace ?? process.env.AGENT_WORKSPACE ?? path.join("src", "agent", "workspace"),
  );
  fs.mkdirSync(sandboxRoot, { recursive: true });
  const sessionsDir = path.resolve(
    projectRoot,
    configuredSessionsDir ?? process.env.AGENT_SESSIONS_DIR ?? path.join("src", "agent", "sessions"),
  );
  const token = process.env.AGENT_API_TOKEN;
  const runtimeDeps: AgentRuntimeDeps = {
    configPath: path.join(projectRoot, "models.json"),
    mcpConfigPath: path.join(projectRoot, "mcp.json"),
    sessionsDir,
    workspaceRoot: projectRoot,
    sandboxRoot,
    logger: req.logger,
    credentials: token ? { token } : {},
    orchestratorRole: "orchestrator",
    parentSignal: signal,
    eventing: req.eventing,
    streamOutput: false,
  };
  req.logger?.debug?.(`[agent-server] building runtime for session ${sessionId}`);
  return buildRuntime(runtimeDeps, sessionId).build();
}

// the middleware IS the lifecycle: it constructs a runtime for this request and wires it onto req; the
// handler drains it via req.closeRuntime() once its work is done. No registry — a fresh runtime per
// request, resuming the session off disk. Reads req.serverConfig/logger/eventing, so it runs after those
// context middleware and after userContext (resolveSessionId reads req.userContext).
export function runtimeContextMiddleware(deps: RuntimeContextDeps): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const sessionId = resolveSessionId(req);
    req.sessionId = sessionId;
    buildForRequest(req, deps.signal, sessionId)
      .then((runtime) => {
        req.agentRuntime = runtime;
        req.runtimeSignal = deps.signal;
        req.closeRuntime = () =>
          runtime.shutdown({ mode: "drain", timeoutMs: 30_000 }).catch((err) => {
            req.logger?.error?.("[agent-server] runtime close failed", err);
          });
        next();
      })
      .catch((err) => {
        req.logger?.error?.("[agent-server] runtime build failed", err);
        res.status(503).json({ error: "runtime unavailable" });
      });
  };
}
