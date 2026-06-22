import type { OrchestratorEvent } from "../runners/runner-events.js";
import type { Eventing } from "@agent-local/common/eventing";
import type { ToolExecutionResult } from "@agent-local/mcp";
import type { ToolDescriptor } from "@agent-local/mcp/tooldescriptor";
import type { Session } from "../session/session.js";
import type { SubSessionCoordinator } from "../runners/subsession.js";
import type { Workspace } from "../registries/workspace-registry.js";
import type { DispatchTracker } from "./dispatch-tracker.js";

// the agent's self-reported turn verdict: status is the parseable answer channel (distinct from the loop's
// outcome), result is the model-supplied structured payload. The runtime wraps these into the wire envelope.
export interface ReportedTurnResult {
  readonly status: "success" | "fail";
  readonly result: unknown;
}

// turn-scoped capture seam for the report_result tool; the orchestrator reads it to terminate the turn
export interface TurnResultSink {
  set(reported: ReportedTurnResult): void;
}

// only the fields tools actually need: tools are pure result-returning functions, side effects stay in the server layer
export interface ToolContext {
  readonly session: Session;
  readonly workspace: Workspace;
  readonly sandboxRoot: string;
  readonly coordinator?: SubSessionCoordinator;
  readonly signal?: AbortSignal;
  // present only on dispatched (non-interactive) turns: where report_result hands its structured verdict back
  readonly resultSink?: TurnResultSink;
}

// the server fires this event after the MCP response is sent, so the tool returns it instead of calling emit
export interface RichToolResult extends ToolExecutionResult {
  readonly event?: OrchestratorEvent;
}

// a synthetic tool looks like a real MCP tool to the LLM but is intercepted and routed internally;
// the contract matches MCP so synthetic and real results wrap into role:"tool" messages through one path
export interface SyntheticMcp {
  readonly name: string;
  readonly descriptor: ToolDescriptor;
  callTool(args: Record<string, unknown>, context: ToolContext): Promise<RichToolResult>;
}

// turn-scoped binding for servers needing signal/tracker/events; the orchestrator casts to this to avoid an import cycle
export interface TurnBindable {
  bindTurn(
    signal: AbortSignal | undefined,
    tracker: DispatchTracker,
    events: Eventing
  ): void;
}

// shapes a synthetic error the same way MCP errors are shaped
export function toolError(content: string): RichToolResult {
  return { isError: true, content };
}

export function toolOk(content: string): RichToolResult {
  return { isError: false, content };
}
