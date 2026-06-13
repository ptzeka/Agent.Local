import path from "node:path";
import { McpClientRegistry } from "../../registries/index.js";
import { createFsLocalMcp, createFsReadonlyLocalMcp } from "../../synthetic-mcp/fs-server.js";
import { createExcelLocalMcp, createExcelReadonlyLocalMcp } from "../../synthetic-mcp/excel-server.js";
import { createSubsessionsLocalMcp } from "../../synthetic-mcp/subsessions-server.js";
import { createDelayLocalMcp } from "../../synthetic-mcp/delay-server.js";
import { ExecutorLocalMcp } from "../../synthetic-mcp/executor-server.js";
import type { RuntimeContext, IMiddleware } from "../types.js";

/**
 * Creates the MCP client registry for the session and registers the in-process
 * MCP servers (fsmcp, Excel, subsessions) on it.
 *
 * Owns the registry's lifecycle: it constructs `McpClientRegistry` bound to the
 * container sandbox root, then registers the synthetic servers. Both are
 * `LocalMcp` instances — plain in-process tool dispatch, no SDK server or
 * transport. They are registered and immediately usable. Spawning real stdio
 * servers declared in mcp.json is not implemented yet; when it lands, each
 * spawned client must receive ctx.runtimeSignal so it self-disposes — there
 * is no registry-side teardown by design.
 *
 * Runs after SessionMiddleware so workspace and session are available for the
 * Excel server's tool context.
 */
export class McpRegistryMiddleware implements IMiddleware {
  async initialize(ctx: RuntimeContext, next: () => Promise<void>): Promise<void> {
    const workspace = ctx.workspace;
    const session = ctx.session;
    if (!workspace || !session) {
      throw new Error("McpRegistryMiddleware: workspace and session must be available in context");
    }

    const sandboxRoot = ctx.sandboxRoot;
    ctx.mcpRegistry = new McpClientRegistry(sandboxRoot);

    // Filesystem/search servers — bound to the session's workspace segment
    // (sandboxRoot/workspaceId) so the Workspace guard in each server enforces
    // confinement at the source: paths the model supplies are resolved relative
    // to this root, and anything that escapes it is rejected before disk access.
    // No path rewriting at the client layer is needed or present.
    const fsRoot = path.join(sandboxRoot, session.workspaceId);
    ctx.mcpRegistry.registerClient(createFsLocalMcp(fsRoot));
    ctx.mcpRegistry.registerClient(createFsReadonlyLocalMcp(fsRoot));

    // Excel server — bound to this session's tool context. Per-turn fields
    // (coordinator, signal) are absent at session setup, matching prior behavior.
    // Mounted twice for the same reason as the filesystem: full set for the
    // executor, inspection-only set for coordinator models.
    const excelToolContext = {
      session,
      workspace,
      sandboxRoot,
      coordinator: undefined,
      signal: undefined,
    };
    ctx.mcpRegistry.registerClient(createExcelLocalMcp(excelToolContext));
    ctx.mcpRegistry.registerClient(createExcelReadonlyLocalMcp(excelToolContext));

    // Subsessions server — same in-process LocalMcp pattern as Excel. Per-turn
    // fields (coordinator, signal) are absent at session setup: the tools
    // advertise, but calls report "not available" until a coordinator is wired.
    ctx.mcpRegistry.registerClient(
      createSubsessionsLocalMcp({
        session,
        workspace,
        sandboxRoot,
        coordinator: undefined,
        signal: undefined,
      })
    );

    // Delay server — a dummy long-running tool for testing. Bound to the runtime
    // signal so a shutdown cancels any pending wait instead of leaving it dangling.
    ctx.mcpRegistry.registerClient(createDelayLocalMcp(ctx.runtimeSignal));

    // Executor server — constructed once with the full RuntimeContext by reference.
    // Per-turn fields (signal, emit, tracker) are injected lazily via bindTurn()
    // at the start of each orchestrator turn before any dispatch can arrive.
    ctx.mcpRegistry.registerClient(new ExecutorLocalMcp(ctx));

    await next();
  }
}
