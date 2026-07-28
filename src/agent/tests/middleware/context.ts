import type { McpClientRegistry } from "../../src/agent/registries/mcp-registry.js";
import type { RuntimeContext } from "../../src/agent/runtime/types.js";
import { Container, type Token } from "@agent-local/common/container";
import { openDatabase, ensureSchema, type DatabaseHandle } from "@agent-local/common/db";
import { AGENT_SCHEMA } from "../../src/db/db-schema.js";
import {
  ConfigurationToken,
  ProvidersToken,
  ModelsToken,
  StoreToken,
  ContextLoaderToken,
  WorkspacesToken,
  McpRegistryToken,
  UserToken,
  SessionToken,
  ConversationToken,
  WorkspaceToken,
  TurnLoopToken,
  InboxToken,
  SessionManagerToken,
} from "../../src/agent/runtime/tokens.js";

// an in-memory agent.sqlite with the real schema ensured: the DB-backed stores (session/conversation/metrics)
// need a schema'd handle, so tests that exercise them share one. Pass it as the `db` override when a test also
// builds a store directly, so both sides read the same connection
export function makeTestDb(): DatabaseHandle {
  const db = openDatabase(":memory:");
  ensureSchema(db, AGENT_SCHEMA);
  return db;
}

// maps the ergonomic override keys tests use (session, store, ...) to the tokens those services live under,
// so seeding a service in a test stays a one-liner: makeContext({ session })
const SERVICE_TOKENS: Record<string, Token<unknown>> = {
  configurationRegistry: ConfigurationToken,
  providerRegistry: ProvidersToken,
  modelsRegistry: ModelsToken,
  store: StoreToken,
  contextLoader: ContextLoaderToken,
  workspaces: WorkspacesToken,
  mcpRegistry: McpRegistryToken,
  user: UserToken,
  session: SessionToken,
  conversation: ConversationToken,
  workspace: WorkspaceToken,
  turnLoop: TurnLoopToken,
  inbox: InboxToken,
  sessionManager: SessionManagerToken,
};

// RuntimeContext seeded with only the infrastructure fields plus a fresh container — the shape
// AgentRuntime.build() hands the first pipeline step; every middleware-populated service starts absent and
// each test seeds just the inputs it reads. The default mcpRegistry is a cast fake exposing getClient(role).
export function makeContext(overrides: Record<string, unknown> = {}): RuntimeContext {
  const mockMcpRegistry = {
    sandboxRoot: "/tmp/agent-mw-test-sandbox",
    getClient: () => ({
      name: "stub",
      listTools: () => [],
      callTool: async () => ({ isError: false, content: "" }),
      shutdown: async () => {},
    }),
  } as unknown as McpClientRegistry;

  const registry = new Container();

  // default-then-override: every present service value lands in the registry under its token
  const services: Record<string, unknown> = { mcpRegistry: mockMcpRegistry, ...overrides };
  for (const [key, serviceToken] of Object.entries(SERVICE_TOKENS)) {
    const value = services[key];
    if (value !== undefined) registry.set(serviceToken, value);
  }

  return {
    registry,
    db: (overrides.db as DatabaseHandle) ?? makeTestDb(),
    sessionsDir: (overrides.sessionsDir as string) ?? "/tmp/agent-mw-test-sessions",
    workspaceRoot: (overrides.workspaceRoot as string) ?? "/tmp/agent-mw-test-workspace",
    sandboxRoot: (overrides.sandboxRoot as string) ?? "/tmp/agent-mw-test-sandbox",
    config: (overrides.config as RuntimeContext["config"]) ?? ({ models: {}, settings: {}, mcpServers: {} } as RuntimeContext["config"]),
    credentials: (overrides.credentials as RuntimeContext["credentials"]) ?? {},
    runtimeSignal: (overrides.runtimeSignal as AbortSignal) ?? new AbortController().signal,
    logger: overrides.logger as RuntimeContext["logger"],
    eventing: overrides.eventing as RuntimeContext["eventing"],
  };
}
