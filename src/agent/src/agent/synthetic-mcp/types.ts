import type { Executor } from "../runners/zzz_executor.js";
import type { OrchestratorEvent, OrchestratorListener } from "../runners/runner-events.js";
import type { ToolExecutionResult } from "../mcp/mcp-client.js";
import type { ToolDescriptor } from "../providers/provider.js";
import type { Session } from "../session/session.js";
import type { SubSessionCoordinator } from "../runners/subsession.js";
import type { Workspace } from "../registries/workspace-registry.js";
import type { DispatchTracker } from "./dispatch-tracker.js";
import { IdentityContext } from "../identity/types.js";

/**
 * Slim context for MCP server tool handlers — only the fields tools actually need.
 * No executor, tracker, or emit: tools are pure functions that return results,
 * and the server layer handles post-call side effects.
 */
export interface ToolContext {
  readonly session: Session;
  readonly workspace: Workspace;
  readonly sandboxRoot: string;
  readonly coordinator?: SubSessionCoordinator;
  readonly signal?: AbortSignal;
}

/**
 * Tool result with optional post-call event. The tool returns this instead of
 * calling emit directly. The server layer checks for the event and fires it
 * after the MCP response is sent.
 */
export interface RichToolResult extends ToolExecutionResult {
  readonly event?: OrchestratorEvent;
}

/**
 * Synthetic tools.
 *
 * A synthetic tool LOOKS like a real MCP tool to the orchestrator's LLM — it is
 * advertised with a `ToolDescriptor` and invoked through a `callTool` that
 * returns a `ToolExecutionResult`, exactly the contract `McpClient.callTool`
 * satisfies. The difference is invisible to the model: the orchestrator
 * intercepts the call before it reaches MCP and routes it internally (to the
 * Executor sub-agent or the SubSessionCoordinator), and may post-process the
 * response. Because the contract matches MCP, the orchestrator wraps synthetic
 * and real tool results into `role:"tool"` messages through one shared path.
 */

/**
 * Everything a synthetic MCP server handler may need that the orchestrator owns for
 * the current turn. Assembled once per `Orchestrator.run` and passed verbatim to
 * every synthetic dispatch, so handlers stay free of orchestrator internals.
 */
export interface SyntheticMcpContext {
  readonly session: Session;
  readonly workspace: Workspace;
  readonly configPath: string;
  readonly sessionsDir: string;
  readonly mcpConfigPath: string;
  readonly credentials: IdentityContext;
  readonly sandboxRoot: string;
  readonly executorMaxIterations: number;
  readonly executorTemperature: number;
  readonly coordinator?: SubSessionCoordinator;
  readonly tracker: DispatchTracker;
  readonly emit: OrchestratorListener;
  readonly signal?: AbortSignal;
}

/**
 * A single synthetic MCP server. `descriptor` is what the LLM sees; `callTool` is the
 * intercepted invocation. The shape deliberately mirrors a real MCP tool so the
 * two can be dispatched and wrapped identically.
 */
export interface SyntheticMcp {
  readonly name: string;
  readonly descriptor: ToolDescriptor;
  callTool(args: Record<string, unknown>, context: ToolContext): Promise<RichToolResult>;
}

/** Shape a non-success synthetic result the same way MCP errors are shaped. */
export function toolError(content: string): RichToolResult {
  return { isError: true, content };
}

/** Shape a successful synthetic result. */
export function toolOk(content: string): RichToolResult {
  return { isError: false, content };
}
