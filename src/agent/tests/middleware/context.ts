import type { McpClientRegistry } from "../../src/agent/registries/mcp-registry.js";
import type { ModelRegistry } from "../../src/agent/registries/model-registry.js";
import type { RuntimeContext } from "../../src/agent/runtime/types.js";

/**
 * Build a RuntimeContext seeded with ONLY the infrastructure fields — exactly
 * the shape AgentRuntime.build() hands to the first pipeline step. Every
 * middleware-populated field starts undefined; each test fills in just the
 * inputs the step under test actually reads.
 *
 * `registry` and `tools` are cast fakes: the middleware tests never drive a turn
 * (which is what would invoke them), they only assert the wiring, so their
 * identity is all that matters.
 */
export function makeContext(overrides: Partial<RuntimeContext> = {}): RuntimeContext {
  const mockRegistry = {} as unknown as ModelRegistry;
  const mockMcpRegistry = {
    listToolsForOrchestrator: () => [],
    listToolsForExecutor: () => [],
    sandboxRoot: "/tmp/agent-mw-test-sandbox",
  } as unknown as McpClientRegistry;

  return {
    registry: mockRegistry,
    mcpRegistry: mockMcpRegistry,
    sessionsDir: "/tmp/agent-mw-test-sessions",
    workspaceRoot: "/tmp/agent-mw-test-workspace",
    mcpConfigPath: "/tmp/mcp.json",
    credentials: {},
    store: undefined,
    workspaces: undefined,
    user: undefined,
    session: undefined,
    workspace: undefined,
    toolDescriptors: undefined,
    orchestrator: undefined,
    inbox: undefined,
    sessionManager: undefined,
    ...overrides,
  };
}
