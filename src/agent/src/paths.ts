import fs from "node:fs";
import path from "node:path";
import url from "node:url";

// Single source of truth for the agent's on-disk layout, shared by the CLI bootstrap and the HTTP server's
// per-request bootstrap so the two can never drift. Nothing is "moved" here — these are the same defaults the
// two sites used to hardcode independently; centralizing just keeps the literals (and the mcp.json walk) in
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

// walk up from startDir to the project root: the dir holding mcp.json, the anchor every other path derives from.
export function findProjectRoot(startDir: string): string {
  let cursor = path.resolve(startDir);
  for (;;) {
    if (fs.existsSync(path.join(cursor, "mcp.json"))) return cursor;
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      throw new Error(`agent: could not locate mcp.json walking up from ${startDir} — launch from inside the workspace`);
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
