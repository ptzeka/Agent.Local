import { OrchestratorEventTypes } from "./runners/runner-events.js";
import type { Eventing } from "@agent-local/common/eventing";
import type { Mcp, ToolExecutionResult, ToolInvoker } from "@agent-local/mcp";
import type { ToolDescriptor } from "@agent-local/mcp/tooldescriptor";

// routes <server>__<tool> calls to the right MCP server and emits TOOL_CALL/TOOL_RESULT events
// path confinement is NOT here: each fs server is rooted at its workspace segment and guards itself
// tolerant routing: small models drop the namespace prefix, so a bare name is matched by unique tail
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
    events?: Eventing,
    signal?: AbortSignal
  ): Promise<ToolExecutionResult> {
    const resolved = this.resolve(name);
    if ("error" in resolved) {
      return { isError: true, content: resolved.error };
    }

    const { client, toolTail } = resolved;

    // required-presence ONLY: confirm each declared `required` key exists before dispatch.
    // value-level checks (types, enums, empty-string) stay server-side — this just turns a
    // missing field into one uniform corrective error instead of a tool-specific string
    // (e.g. dispatch's "[dispatch-error] intent is required") or a silent malformed call.
    const missing = this.missingRequired(client, toolTail, args);
    if (missing.length > 0) {
      return {
        isError: true,
        content:
          `[input-error] tool "${name}" is missing required field(s): ${missing.join(", ")}. ` +
          `Re-emit the call including ${missing.length === 1 ? "it" : "them"}.`,
      };
    }

    events?.publish(OrchestratorEventTypes.TOOL_CALL, { id: "", name, arguments: args });
    // timeout policy lives in the server; the client only routes and forwards the turn's signal
    const result = await client.callTool(toolTail, args, signal);
    events?.publish(OrchestratorEventTypes.TOOL_RESULT, {
      id: "",
      name,
      isError: result.isError,
      contentPreview: result.content.slice(0, 400),
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
          break;
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

  // presence-only gate: read the resolved tool's advertised `inputSchema.required` and return the
  // declared keys absent from `args`. presence ≠ non-empty — `intent: ""` passes here by design, an
  // empty value is the server's to reject. a tool with no `required` array (or none missing) yields [].
  private missingRequired(client: Mcp, toolTail: string, args: Record<string, unknown>): string[] {
    const fullName = `${client.name}__${toolTail}`;
    const descriptor = client.listTools().find((t) => t.name === fullName);
    const required = descriptor?.inputSchema?.required;
    if (!Array.isArray(required)) return [];
    return required.filter((key): key is string => typeof key === "string" && !(key in args));
  }
}
