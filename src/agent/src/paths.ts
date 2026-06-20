import fs from "node:fs";
import path from "node:path";
import url from "node:url";

// Single source of truth for the agent's on-disk layout, shared by the CLI bootstrap and the HTTP server's
// per-request bootstrap so the two can never drift. Nothing is "moved" here — these are the same defaults the
// two sites used to hardcode independently; centralizing just keeps the literals (and the project-root walk) in
// one place. Paths stay relative to the project root so src-, dist-, and cwd-independent runs all agree.

export const WORKSPACE_ENV = "AGENT_WORKSPACE";
export const SESSIONS_DIR_ENV = "AGENT_SESSIONS_DIR";

// the fs sandbox: agent file I/O is confined here, one folder per workspaceId. sessions transcripts sit beside it.
const DEFAULT_WORKSPACE = path.join("src", "agent", "workspace");
const DEFAULT_SESSIONS_DIR = path.join("src", "agent", "sessions");

// the dir of the calling module — the conventional start point for findProjectRoot (pass `import.meta.url`).
export function moduleDir(metaUrl: string): string {
  return url.fileURLToPath(new URL(".", metaUrl));
}

// the monorepo root is the package.json named exactly "agent-local"; a substring match would stop early at a
// nested workspace (e.g. @agent-local/agent), so the name must equal the root's. Returns null on a non-root or
// unreadable package.json so the walk keeps climbing rather than anchoring on the wrong dir.
const ROOT_PACKAGE_NAME = "agent-local";
function isProjectRoot(dir: string): boolean {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8")) as { name?: string };
    return pkg.name === ROOT_PACKAGE_NAME;
  } catch {
    return false;
  }
}

// walk up from startDir to the project root: the dir whose package.json is the workspace root ("agent-local").
// anchoring on package.json (not mcp.json) decouples the root marker from optional MCP config — a missing or
// renamed mcp.json no longer prevents the agent from locating its root.
export function findProjectRoot(startDir: string): string {
  let cursor = path.resolve(startDir);
  for (;;) {
    if (isProjectRoot(cursor)) return cursor;
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      throw new Error(`agent: could not locate the "${ROOT_PACKAGE_NAME}" package.json walking up from ${startDir} — launch from inside the workspace`);
    }
    cursor = parent;
  }
}

// the fs sandbox root. Precedence: explicit config (appsettings) > AGENT_WORKSPACE > default. A relative value
// resolves against projectRoot (not cwd), so the same override behaves identically from the CLI and the server.
export function resolveSandboxRoot(projectRoot: string, configured?: string): string {
  return path.resolve(projectRoot, configured ?? process.env[WORKSPACE_ENV] ?? DEFAULT_WORKSPACE);
}

// where session transcripts live; same precedence/resolution rules as resolveSandboxRoot.
export function resolveSessionsDir(projectRoot: string, configured?: string): string {
  return path.resolve(projectRoot, configured ?? process.env[SESSIONS_DIR_ENV] ?? DEFAULT_SESSIONS_DIR);
}
