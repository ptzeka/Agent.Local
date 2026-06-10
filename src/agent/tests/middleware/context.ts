import type { McpClient } from "../../src/agent/mcp-client.js";
import type { ModelRegistry } from "../../src/agent/model-registry.js";
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
  return {
    registry: {} as unknown as ModelRegistry,
    tools: {} as unknown as McpClient,
    sessionsDir: "/tmp/agent-mw-test-sessions",
    workspaceRoot: "/tmp/agent-mw-test-workspace",
    credentials: {},
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
