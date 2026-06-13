import type { RunnerListener } from "./runners/runner-events.js";
import { OrchestratorEventTypes } from "./runners/runner-events.js";
import type { Mcp, ToolExecutionResult, ToolInvoker } from "./mcp/mcp.js";
import type { ToolDescriptor } from "./providers/provider.js";

/**
 * Routes `<server>__<tool>` calls to the correct in-process MCP server and
 * emits TOOL_CALL / TOOL_RESULT events for the REPL renderer.
 *
 * Path confinement is NOT the responsibility of this class. Each synthetic fs
 * server is constructed with its workspace segment as root (sandboxRoot +
 * workspaceId), so the Workspace guard inside the server enforces confinement
 * deterministically — before any disk access, without client-side rewriting.
 *
 * Tolerant routing: small models routinely drop the `<server>__` namespace
 * prefix. When the name is bare (no `__`), we search all mounted servers for
 * a unique tail match and route it. Ambiguous or missing names return a
 * corrective error that names the real candidates.
 */
export class ScopedToolClient implements ToolInvoker {
  private readonly clientsByServer: Map<string, Mcp>;

  constructor(clients: Mcp[]) {
    this.clientsByServer = new Map(clients.map((c) => [c.name, c]));
  }

  public listTools(): ToolDescriptor[] {
    const tools: ToolDescriptor[] = [];
    for (const client of this.clientsByServer.values()) {
      tools.push(...client.listTools());
    }
    return tools;
  }

  public async callTool(
    name: string,
    args: Record<string, unknown>,
    emit?: RunnerListener,
    signal?: AbortSignal
  ): Promise<ToolExecutionResult> {
    const resolved = this.resolve(name);
    if ("error" in resolved) {
      return { isError: true, content: resolved.error };
    }

    const { client, toolTail } = resolved;

    emit?.({ type: OrchestratorEventTypes.TOOL_CALL, data: { id: "", name, arguments: args } });
    // Timeout policy lives in the server (it wraps this signal in its own
    // CancellationToken); the client only routes and forwards the turn's signal.
    const result = await client.callTool(toolTail, args, signal);
    emit?.({
      type: OrchestratorEventTypes.TOOL_RESULT,
      data: { id: "", name, isError: result.isError, contentPreview: result.content.slice(0, 400) },
    });
    return result;
  }

  // ---------------------------------------------------------------------------

  private resolve(name: string): { client: Mcp; toolTail: string } | { error: string } {
    const sep = name.indexOf("__");

    if (sep !== -1) {
      const serverName = name.slice(0, sep);
      const toolTail = name.slice(sep + 2);
      const client = this.clientsByServer.get(serverName);
      if (!client) {
        const mounted = [...this.clientsByServer.keys()].join(", ");
        return {
          error:
            `Unknown server "${serverName}" in tool call "${name}". ` +
            `Mounted servers: ${mounted}. Use namespaced as <server>__<tool>.`,
        };
      }
      return { client, toolTail };
    }

    // Bare name: find every server that advertises a tool whose tail matches.
    const owners: Array<{ client: Mcp; toolTail: string }> = [];
    for (const client of this.clientsByServer.values()) {
      for (const tool of client.listTools()) {
        const tail = tool.name.slice(tool.name.indexOf("__") + 2);
        if (tail === name) {
          owners.push({ client, toolTail: name });
          break; // one match per server is enough
        }
      }
    }

    if (owners.length === 1) {
      return owners[0];
    }

    if (owners.length > 1) {
      const candidates = owners
        .map((o) => `${o.client.name}__${name}`)
        .join(", ");
      return {
        error:
          `Ambiguous bare tool name "${name}": multiple servers expose it. ` +
          `Use a namespaced name: ${candidates}`,
      };
    }

    const mounted = [...this.clientsByServer.keys()].join(", ");
    return {
      error:
        `Unknown tool "${name}": not found on any mounted server (${mounted}). ` +
        `Use namespaced as <server>__<tool>.`,
    };
  }
}
