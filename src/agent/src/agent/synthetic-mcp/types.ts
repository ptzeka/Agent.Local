import type { Executor } from "../executor.js";
import type { OrchestratorEvent, OrchestratorListener } from "../orchestrator-events.js";
import type { ToolExecutionResult } from "../mcp-client.js";
import type { ToolDescriptor } from "../providers/provider.js";
import type { Session } from "../session.js";
import type { SubSessionCoordinator } from "../subsession.js";
import type { Workspace } from "../workspace-registry.js";
import type { DispatchTracker } from "./dispatch-tracker.js";

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
  /** The session this turn runs against; source of the (un-spoofable) parent id. */
  readonly session: Session;
  /** Workspace sandbox shared with any spawned executor or child session. */
  readonly workspace: Workspace;
  /**
   * The file-sandbox container root (AGENT_WORKSPACE) every MCP server runs
   * against. Synthetic tools that touch disk in-process (e.g. the Excel tools)
   * resolve under `{sandboxRoot}/{workspace.workspaceId}/` so their files land
   * in the exact same segment fsmcp / the executor write to.
   */
  readonly sandboxRoot: string;
  /** The executor sub-agent — the sole path to a mutation. */
  readonly executor: Executor;
  /** Hard cap on executor LLM iterations per dispatch (from orchestration config). */
  readonly executorMaxIterations: number;
  /** Sampling temperature for the executor LLM (from orchestration config). */
  readonly executorTemperature: number;
  /** Present only when sub-sessions are enabled for this run. */
  readonly coordinator?: SubSessionCoordinator;
  /** Per-turn dispatch accounting (cap, duplicate guard, periodic-check gate). */
  readonly tracker: DispatchTracker;
  /** Surface orchestrator events from inside a handler. */
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
