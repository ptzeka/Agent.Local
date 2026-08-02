import { ContextLoader } from "../../context/context-loader.js";
import { fillToolsList } from "../../context/system-prompt.js";
import type { ToolDescriptor } from "@agent-local/mcp/tooldescriptor";
import {
  ContextLoaderToken,
  McpRegistryToken,
  ModelsToken,
  ProvidersToken,
  SessionToken,
  StoreToken,
  WorkspaceToken,
} from "../tokens.js";
import type { IMiddleware, RuntimeContext } from "../types.js";

export interface ContextMiddlewareParams {
  roleName: string;
}

// captures the non-conversation context the orchestrator sends and stamps its content-addressed hash on the session
// observability, not behaviour: answers "what context did session X run on" without bloating every session file
// place after SessionMiddleware: requires ctx.session, ctx.workspace, ctx.store
export class ContextMiddleware implements IMiddleware {
  constructor(private readonly params: ContextMiddlewareParams) {}

  async initialize(ctx: RuntimeContext, next: () => Promise<void>): Promise<void> {
    // get() throws if the session/workspace steps have not run; this step stamps the session and reads the workspace
    const session = ctx.registry.get(SessionToken);
    ctx.registry.get(WorkspaceToken);
    // snapshots live in the contexts table on ctx.db (the shared startup handle)
    if (!ctx.registry.has(ContextLoaderToken)) {
      ctx.registry.set(ContextLoaderToken, ContextLoader.create(ctx.db));
    }
    const role = this.params.roleName;

    // declared-but-unconnected servers resolve to undefined and are skipped, so the snapshot reflects what is mounted
    const mcpRegistry = ctx.registry.get(McpRegistryToken);
    const serverNames = ctx.registry.get(ModelsToken).getValidMcpServersForRole(role);
    const tools = serverNames.flatMap((serverName) => mcpRegistry.getClient(serverName)?.listTools() ?? []);

    await this.stampRoleSnapshot(ctx, role, tools);

    // summarizer/evaluator read their prompts from these snapshots too (context comes ONLY from here); no tools by design
    await this.stampRoleSnapshot(ctx, "summarizer", []);
    await this.stampRoleSnapshot(ctx, "evaluator", []);

    await ctx.registry.get(StoreToken).save(session);
    await next();
  }

  // does not save the session: the caller saves once after all roles, so hashes land durably even if turn 1 never finalizes
  private async stampRoleSnapshot(
    ctx: RuntimeContext,
    role: string,
    tools: ToolDescriptor[]
  ): Promise<void> {
    const modelsRegistry = ctx.registry.get(ModelsToken);
    const contextLoader = ctx.registry.get(ContextLoaderToken);
    const projectTemplate = modelsRegistry.getPromptTemplate("project");
    const agentTemplate = modelsRegistry.getPromptTemplate(role);
    const systemPrompt = fillToolsList(agentTemplate, tools);
    const provider = ctx.registry.get(ProvidersToken).getProvider(modelsRegistry.getProviderForRole(role));
    const context = contextLoader.buildContext(
      role,
      systemPrompt,
      projectTemplate || '',
      tools,
      provider.supportsNativeTools
    );
    const hash = await contextLoader.saveContextSnapshot(context);

    const session = ctx.registry.get(SessionToken);
    session.contextHashes ??= {};
    session.contextHashes[role] = hash;
  }

}
