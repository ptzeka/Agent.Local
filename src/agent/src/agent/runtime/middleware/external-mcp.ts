import { readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpClient } from "@agent-local/mcp/mcp-client";
import type { Mcp } from "@agent-local/mcp";
import type { ILogger } from "@agent-local/common/ilogger";

// one server entry from mcp.json — the same shape the MCP spec (and Claude Code) use
export interface McpServerDef {
  command: string;
  args?: string[];
  // explicit env wins over the inherited safe defaults; keep secrets here, never in args (and don't commit them)
  env?: Record<string, string>;
  // working dir for the spawned process; defaults to the server's package root so cwd-relative
  // resolution (e.g. codemcp's index auto-discovery) works without per-server config
  cwd?: string;
}

// the mcpServers map from mcp.json; a missing/!malformed file yields no servers rather than throwing,
// so a runtime without external servers configured simply mounts the synthetic ones.
export function readMcpServerDefs(mcpConfigPath: string): Record<string, McpServerDef> {
  try {
    const parsed = JSON.parse(readFileSync(mcpConfigPath, "utf-8")) as {
      mcpServers?: Record<string, McpServerDef>;
    };
    return parsed.mcpServers ?? {};
  } catch {
    return {};
  }
}

// spawn one stdio MCP server and wrap its live connection as an Mcp. The returned client self-disposes
// when `signal` aborts (the runtime's signal) — there is no registry-side teardown. `extraArgs` are
// appended after the configured args, used to inject per-session flags (e.g. memomcp --collection).
export async function mountExternalMcp(
  name: string,
  def: McpServerDef,
  opts: { timeout: number; signal: AbortSignal; extraArgs?: string[]; logger?: ILogger },
): Promise<Mcp> {
  const transport = new StdioClientTransport({
    command: def.command,
    args: [...(def.args ?? []), ...(opts.extraArgs ?? [])],
    env: def.env ? { ...getDefaultEnvironment(), ...def.env } : undefined,
    cwd: def.cwd ?? defaultCwd(def.args),
    // capture the child's stderr rather than inheriting it: server startup banners (e.g. memomcp's
    // WARN/serving lines) must not leak to the terminal and corrupt the REPL pinned prompt on remount
    stderr: "pipe",
  });
  const client = new Client({ name: `agent-${name}`, version: "0.1.0" });
  await client.connect(transport);
  drainStderr(name, transport, opts.logger);
  const mcp = await McpClient.createFromConnection(name, client, opts.signal);
  return mcp.setTimeout(opts.timeout);
}

// route the spawned server's stderr to the debug log line-by-line — diagnostics are kept but off-screen
function drainStderr(name: string, transport: StdioClientTransport, logger?: ILogger): void {
  const stream = transport.stderr;
  if (!stream || !logger) return;
  let buffer = "";
  stream.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf-8");
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trimEnd();
      buffer = buffer.slice(newline + 1);
      if (line) logger.debug("mcp stderr", { name, line });
    }
  });
}

// node <abs>/<pkg>/dist/server.js -> <abs>/<pkg>; so a server that resolves data relative to its
// package dir (codemcp) finds it without the launcher having to cd first.
function defaultCwd(args?: string[]): string | undefined {
  const script = args?.find((a) => a.endsWith(".js"));
  if (!script) return undefined;
  return path.dirname(path.dirname(path.resolve(script)));
}
