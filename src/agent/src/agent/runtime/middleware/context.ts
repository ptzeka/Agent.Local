import path from "node:path";
import { ContextLoader } from "../../context/context-loader.js";
import { fillToolsList } from "../../context/system-prompt.js";
import type { ToolDescriptor } from "../../providers/provider.js";
import type { IMiddleware, RuntimeContext } from "../types.js";

export interface ContextMiddlewareParams {
  /**
   * Role for which to build context ("orchestrator", "executor", etc).
   */
  roleName: string;
  /**
   * Directory for content-addressed context snapshots. Defaults to a `contexts`
   * folder beside the sessions dir (so `…/sessions` and `…/contexts` sit together).
   */
  contextsDir?: string;
  /**
   * Whether the snapshot's tool block includes the sub-session tools. Matches
   * what the orchestrator actually advertises: a top-level run gets them (true,
   * the default); a sub-session runs without a coordinator and never sees them
   * (false), so its snapshot — and therefore its contextHash — is faithfully
   * reduced.
   */
  includeSubSessions?: boolean;
}

/**
 * ContextMiddleware — captures the non-conversation context (system prompt,
 * project direction, tool block) the orchestrator will send, stores it once per
 * unique fingerprint under the contexts dir, and stamps the resulting hash onto
 * the session.
 *
 * This is observability/documentation, not behaviour: it lets you answer "what
 * context did session X run on" without bloating every session file with the
 * large, repeating prefix. The snapshot is content-addressed, so N sessions
 * sharing the same context cost a single file.
 *
 * Requires ctx.session + ctx.workspace (from SessionMiddleware) and ctx.store
 * (from StoreMiddleware); reads ctx.registry/ctx.tools (always seeded). Place it
 * after SessionMiddleware in the pipeline.
 */
export class ContextMiddleware implements IMiddleware {
  constructor(private readonly params: ContextMiddlewareParams) {}

  async initialize(ctx: RuntimeContext, next: () => Promise<void>): Promise<void> {
    if (!ctx.session || !ctx.workspace || !ctx.store) {
      throw new Error(
        "ContextMiddleware: requires ctx.session, ctx.workspace and ctx.store. " +
          "Add StoreMiddleware and SessionMiddleware earlier in the pipeline."
      );
    }
    // Default the snapshot store to a `contexts` folder beside the sessions dir
    // (…/sessions and …/contexts sit together) when no explicit dir is given.
    const contextsDir = this.params.contextsDir ?? path.join(path.dirname(ctx.sessionsDir), "contexts");
    ctx.contextLoader ??= new ContextLoader(contextsDir);
    const role = this.params.roleName;

    // Resolve the role's tools by combining every MCP server the role's model is
    // allowed to use (role → model → models.json `mcp` list). Servers that are
    // declared but not yet connected (e.g. codemcp, subsessions) resolve to
    // undefined and are skipped, so the snapshot reflects what is actually mounted.
    const serverNames = ctx.modelsRegistry!
      .getValidMcpServersForRole(role)
      // A coordinator-less run never advertises the sub-session tools, so its
      // snapshot must not record them either — the hash stays faithful.
      .filter((serverName) => this.params.includeSubSessions !== false || serverName !== "subsessions");
    const tools = serverNames.flatMap((serverName) => ctx.mcpRegistry!.getClient(serverName)?.listTools() ?? []);

    await this.stampRoleSnapshot(ctx, role, tools);

    // The summarizer and evaluator read their system prompts from the same
    // hashed snapshots (context comes ONLY from here, never from constants at
    // call time), so stamp a pointer for each. Both are pure text-in/text-out
    // roles — no tools, by design.
    await this.stampRoleSnapshot(ctx, "summarizer", []);
    await this.stampRoleSnapshot(ctx, "evaluator", []);

    await ctx.store.save(ctx.session);
    await next();
  }

  /**
   * Build, persist, and stamp the context snapshot for one role. The session is
   * NOT saved here — the caller saves once after all roles are stamped, so the
   * hashes land durably from init even if the first turn never reaches finalize().
   */
  private async stampRoleSnapshot(
    ctx: RuntimeContext,
    role: string,
    tools: ToolDescriptor[]
  ): Promise<void> {
    const projectTemplate = ctx.modelsRegistry?.getPromptTemplate("project");
    const agentTemplate = ctx.modelsRegistry!.getPromptTemplate(role);
    const systemPrompt = fillToolsList(agentTemplate, tools);
    const provider = ctx.providerRegistry!.getProvider(ctx.modelsRegistry!.getProviderForRole(role));
    const context = ctx.contextLoader!.buildContext(
      role,
      systemPrompt,
      projectTemplate || '',
      tools,
      provider.supportsNativeTools
    );
    const hash = await ctx.contextLoader!.saveContextSnapshot(context);

    ctx.session!.contextHashes ??= {};
    ctx.session!.contextHashes[role] = hash;
  }

}
