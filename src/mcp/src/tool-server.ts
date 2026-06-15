import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ToolDescriptor } from "./tooldescriptor.js";

// a server-hosted tool: the advertised ToolDescriptor surface plus a handler returning text.
// Deps is the injected dependency bundle (db readers, embedder, ...) the host never inspects.
export interface ServerTool<Deps> extends ToolDescriptor {
  handler(input: unknown, deps: Deps): Promise<string>;
}

export interface McpToolServerOptions<Deps> {
  name: string;
  version: string;
  tools: ServerTool<Deps>[];
  // injected once, passed to every handler — no handler resolves its own dependencies
  deps: Deps;
  // released on shutdown after the transport closes; keep it idempotent. errors are swallowed
  // so a hung resource cannot block process exit.
  onShutdown?(): Promise<void>;
}

const DEFAULT_SIGNALS: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM"];

// one stdio MCP server hosting a fixed tool set. owns the transport and lifecycle so every
// server in the family (codemcp, memomcp, ...) shares identical ListTools/CallTool semantics
// and shutdown behavior — add a capability here once and all servers inherit it. behavior is
// configured through options, not subclassing, so the contract callers see stays closed.
export class McpToolServer<Deps> {
  private readonly server: Server;
  // guards against re-entrant shutdown (double Ctrl-C, SIGINT then SIGTERM): cleanup runs once
  private shuttingDown = false;
  private readonly signalHandlers = new Map<NodeJS.Signals, () => void>();

  constructor(private readonly options: McpToolServerOptions<Deps>) {
    this.server = new Server(
      { name: options.name, version: options.version },
      { capabilities: { tools: {} } },
    );
    this.registerHandlers();
  }

  private registerHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.options.tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const tool = this.options.tools.find((t) => t.name === request.params.name);
      if (!tool) {
        return {
          content: [{ type: "text" as const, text: `unknown tool: ${request.params.name}` }],
          isError: true,
        };
      }
      try {
        const text = await tool.handler(request.params.arguments ?? {}, this.options.deps);
        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `${tool.name} failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    });
  }

  // connect the stdio transport and arm signal-driven shutdown. resolves once connected; the
  // process then stays alive on the transport until a registered signal triggers shutdown.
  async start(signals: readonly NodeJS.Signals[] = DEFAULT_SIGNALS): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    for (const signal of signals) {
      const handler = (): void => { void this.shutdown(0); };
      this.signalHandlers.set(signal, handler);
      process.on(signal, handler);
    }
  }

  // idempotent graceful shutdown: detaches signal handlers and flips the guard synchronously
  // (no await before either) so a second signal during async cleanup is a no-op, then closes
  // the transport, releases injected resources, and exits.
  async shutdown(code = 0): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    for (const [signal, handler] of this.signalHandlers) {
      process.removeListener(signal, handler);
    }
    this.signalHandlers.clear();
    try { await this.server.close(); } catch { /* transport already gone */ }
    try { await this.options.onShutdown?.(); } catch { /* best-effort resource release */ }
    process.exit(code);
  }
}
