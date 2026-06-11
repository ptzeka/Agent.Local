import type { McpClientRegistry } from "../../src/agent/registries/mcp-registry.js";
import type { RuntimeContext } from "../../src/agent/runtime/types.js";

/**
 * Build a RuntimeContext seeded with ONLY the infrastructure fields — exactly
 * the shape AgentRuntime.build() hands to the first pipeline step. Every
 * middleware-populated field starts undefined; each test fills in just the
 * inputs the step under test actually reads.
 *
 * The default `mcpRegistry` is a cast fake exposing the member middleware
 * reaches for without driving a turn: `getClient(role)` (ContextMiddleware).
 * `sandboxRoot` lives on the context itself (read by SessionMiddleware). Tests
 * that need richer behavior pass their own
 * `mcpRegistry`/`modelsRegistry`/`providerRegistry` overrides.
 */
export function makeContext(overrides: Partial<RuntimeContext> = {}): RuntimeContext {
  const mockMcpRegistry = {
    sandboxRoot: "/tmp/agent-mw-test-sandbox",
    getClient: () => ({
      name: "stub",
      listTools: () => [],
      callTool: async () => ({ isError: false, content: "" }),
      shutdown: async () => {},
    }),
  } as unknown as McpClientRegistry;

  return {
    mcpRegistry: mockMcpRegistry,
    sessionsDir: "/tmp/agent-mw-test-sessions",
    workspaceRoot: "/tmp/agent-mw-test-workspace",
    sandboxRoot: "/tmp/agent-mw-test-sandbox",
    mcpConfigPath: "/tmp/mcp.json",
    credentials: {},
    providerRegistry: undefined,
    modelsRegistry: undefined,
    configurationRegistry: undefined,
    logger: undefined,
    store: undefined,
    workspaces: undefined,
    user: undefined,
    session: undefined,
    workspace: undefined,
    orchestrator: undefined,
    inbox: undefined,
    sessionManager: undefined,
    ...overrides,
  };
}
