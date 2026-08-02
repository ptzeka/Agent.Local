import type { Principal } from "../identity/types.js";
import type { RunResult } from "../runners/turn-loop.js";
import type { Session, UsageTotals } from "../session/session.js";
import { AgentRuntime } from "./agent-runtime.js";
import { McpRegistryMiddleware } from "./middleware/mcp-registry.js";
import { ContainerMiddleware } from "./middleware/container.js";
import { EventingMiddleware } from "./middleware/eventing.js";
import { ChildSessionMiddleware } from "./middleware/child-session.js";
import { ContextMiddleware } from "./middleware/context.js";
import { ConversationMiddleware } from "./middleware/conversation.js";
import { InheritedUserMiddleware } from "./middleware/inherited-user.js";
import { InputInboxMiddleware } from "./middleware/input-inbox.js";
import { LoggerMiddleware } from "./middleware/logger.js";
import { TurnLoopMiddleware } from "./middleware/turn-loop.js";
import { MetricsRegistryMiddleware } from "./middleware/metrics-registry.js";
import { RunnerPipelineMiddleware } from "./middleware/runner-pipeline.js";
import { StoreMiddleware } from "./middleware/store.js";
import { ConfigurationMiddleware } from "./middleware/configuration.js"
import { WorkspaceRegistryMiddleware } from "./middleware/workspace-registry.js";
import type { AgentRuntimeDeps } from "./types.js";
import { ProvidersMiddleware } from "./middleware/providers.js";
import { ModelsMiddleware } from "./middleware/models.js";

// what a spawner must supply to stand a child up; the caller mints the sessionId so it can name the run
// before the pipeline exists
export interface SubRuntimeRefs {
  sessionId: string;
  parentSessionId: string;
  workspaceId: string;
  user?: Principal;
  standingContext?: string;
  // cancellation link: the child dies with its caller's tool call, the parent runtime, or the process root
  parentSignal?: AbortSignal;
}

// the child surface a spawner uses, narrower than AgentRuntime so a caller can neither steer the child's
// loop nor reach into the parent's registries through it
export interface ChildRuntime {
  build(): Promise<ChildRuntime>;
  getSession(): Session;
  // the child's cumulative token tally, folded into the caller's usage so a delegated spend is never lost;
  // returns plain data (not the registry) so this contract stays free of runtime-layer types
  metricsTotals(): Readonly<UsageTotals>;
  dispatchAsync(input: string, options?: { signal?: AbortSignal }): Promise<RunResult>;
  injectInput(content: string, source?: string): void;
  // persist to stamp the child's terminal done/error status
  finalize(): Promise<void>;
}

// the top-level pipeline with three steps swapped for parent-fed variants (inherited user, child session, context)
// returned UNBUILT like buildRuntime; the caller awaits .build() then drives one dispatchAsync
export function buildSubRuntime(deps: AgentRuntimeDeps, refs: SubRuntimeRefs): AgentRuntime {
  // cancellation parent is the spawn's derived signal, not deps' process-root signal
  const childDeps: AgentRuntimeDeps = {
    ...deps,
    parentSignal: refs.parentSignal ?? deps.parentSignal,
    // a sub-run has no live renderer of its own; it reports through the executor bridge, so it stays collect-only
    streamOutput: false,
    // honour the caller's role: the executor dispatch needs EXECUTOR_ROLE (no dispatch seam, write tools
    // instead), while a role-agent dispatch pins the agent's own role at its call site
    orchestratorRole: deps.orchestratorRole,
  };
  return new AgentRuntime(childDeps)
    .add(new ContainerMiddleware())
    // no parent bus: a child is its own event root, reaching the parent via the executor MCP bridge
    .add(new EventingMiddleware())
    .add(new LoggerMiddleware({ logger: deps.logger }))
    .add(new ConfigurationMiddleware({ config: deps.config }))
    .add(new ProvidersMiddleware())
    .add(new ModelsMiddleware())
    .add(new StoreMiddleware())
    .add(new WorkspaceRegistryMiddleware())
    .add(new InheritedUserMiddleware(refs.user))
    .add(
      new ChildSessionMiddleware({
        sessionId: refs.sessionId,
        parentSessionId: refs.parentSessionId,
        workspaceId: refs.workspaceId,
      })
    )
    // standing context seeds the child's fresh conversation, so it rides the conversation step, not the session step
    .add(new ConversationMiddleware({ standingContext: refs.standingContext }))
    .add(new MetricsRegistryMiddleware())
    .add(new McpRegistryMiddleware({ role: childDeps.orchestratorRole }))
    .add(new TurnLoopMiddleware({ role: childDeps.orchestratorRole }))
    .add(new RunnerPipelineMiddleware())
    .add(new ContextMiddleware({ roleName: childDeps.orchestratorRole }))
    .add(new InputInboxMiddleware());
}
