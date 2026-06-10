import type { ToolDescriptor } from "../../providers/provider.js";
import type { SubSessionCoordinator, SubSessionSnapshot } from "../../runners/subsession.js";
import { toolError, toolOk, type RichToolResult, type SyntheticMcp, type ToolContext } from "../types.js";

export const CREATE_SUBSESSION_TOOL = "create_subsession";
export const SUBSESSION_STATUS_TOOL = "get_subsession_status";
export const LIST_SUBSESSIONS_TOOL = "list_subsessions";
export const FINALIZE_SUBSESSION_TOOL = "finalize_subsession";

/**
 * Sub-session synthetic tools.
 *
 * Each is intercepted before MCP and routed to the SubSessionCoordinator.
 * `parentSessionId` is always taken from the context's session — the LLM never
 * supplies it, so it can't be spoofed or get out of sync, and it never appears
 * in any schema. These tools are only built (and therefore only advertised) when
 * a coordinator is wired in, which enforces the one-level-deep guard at source.
 */

/**
 * Build subsession tool descriptors for advertisement (without creating handlers).
 * Used to include subsession tools in the visible tools list at turn setup.
 */
export function getSubsessionToolDescriptors(): ToolDescriptor[] {
  return createSubSessionTools().map((tool) => ({
    name: tool.name,
    description: tool.descriptor.description,
    inputSchema: tool.descriptor.inputSchema,
  }));
}

export function createSubSessionTools(): SyntheticMcp[] {
  return [
    {
      name: CREATE_SUBSESSION_TOOL,
      descriptor: createDescriptor(),
      callTool: handleCreate,
    },
    {
      name: SUBSESSION_STATUS_TOOL,
      descriptor: statusDescriptor(),
      callTool: handleStatus,
    },
    {
      name: LIST_SUBSESSIONS_TOOL,
      descriptor: listDescriptor(),
      callTool: handleList,
    },
    {
      name: FINALIZE_SUBSESSION_TOOL,
      descriptor: finalizeDescriptor(),
      callTool: handleFinalize,
    },
  ];
}

// ---------------------------------------------------------------------------
// Handlers. Each guards on a present coordinator first, then routes.
// ---------------------------------------------------------------------------

async function handleCreate(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<RichToolResult> {
  const coordinator = requireCoordinator(ctx);
  if (!coordinator) return toolError("[subsession-error] sub-sessions are not available in this run");

  const intent = args.intent;
  if (typeof intent !== "string" || intent.trim().length === 0) {
    return toolError("[subsession-error] create_subsession.intent must be a non-empty string");
  }
  const context = typeof args.context === "string" ? args.context : undefined;

  const result = coordinator.createSubSession({
    parentSessionId: ctx.session.sessionId,
    workspace: ctx.workspace,
    intent,
    context,
    // Inherit the parent's identity so the child runs (and persists) under the
    // same principal rather than as a fresh anonymous session.
    user: ctx.session.user,
  });

  // Rejected by the per-parent cap — surface as an error so the model waits on
  // or finalizes an existing child instead of retrying blindly.
  if (result.outcome === "rejected" || !result.snapshot) {
    return {
      isError: true,
      content: `[subsession-error] ${result.reason ?? "sub-session creation rejected"}`,
      event: { type: "subsession-start", data: { intent, outcome: "rejected", reason: result.reason } },
    };
  }

  // created or reused — both return the live child's snapshot. The reused note
  // tells the model it already has this work in flight.
  const prefix = result.outcome === "reused" ? `[subsession-reused] ${result.reason}\n` : "";
  return {
    isError: false,
    content: prefix + snapshotJson(result.snapshot),
    event: {
      type: "subsession-start",
      data: { subSessionId: result.snapshot.subSessionId, intent, outcome: result.outcome },
    },
  };
}

async function handleStatus(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<RichToolResult> {
  const coordinator = requireCoordinator(ctx);
  if (!coordinator) return toolError("[subsession-error] sub-sessions are not available in this run");

  const subSessionId = requireSubSessionId(args, SUBSESSION_STATUS_TOOL);
  if (!subSessionId.ok) return toolError(subSessionId.reason);

  const result = await coordinator.getStatus(ctx.session.sessionId, subSessionId.value, ctx.signal);
  if (!result) {
    return toolError(`[subsession-error] unknown subSessionId "${subSessionId.value}" for this session`);
  }

  // When a backoff was applied the status hasn't changed since last poll — tell
  // the model to stop hammering and do other work before re-checking.
  const note =
    result.backoffMs > 0
      ? `[backoff ${result.backoffMs}ms — status unchanged ("${result.snapshot.status}") since your last check; ` +
        `do other useful work or finalize it instead of polling again immediately]\n`
      : "";

  return {
    isError: false,
    content: note + snapshotJson(result.snapshot),
    event: {
      type: "subsession-status",
      data: { subSessionId: subSessionId.value, status: result.snapshot.status, backoffMs: result.backoffMs },
    },
  };
}

async function handleList(
  _args: Record<string, unknown>,
  ctx: ToolContext
): Promise<RichToolResult> {
  const coordinator = requireCoordinator(ctx);
  if (!coordinator) return toolError("[subsession-error] sub-sessions are not available in this run");

  const snapshots = coordinator.list(ctx.session.sessionId);
  const resultContent = JSON.stringify({ count: snapshots.length, subSessions: snapshots }, null, 2);
  return {
    isError: false,
    content: resultContent,
    event: { type: "subsession-status", data: { count: snapshots.length } },
  };
}

async function handleFinalize(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<RichToolResult> {
  const coordinator = requireCoordinator(ctx);
  if (!coordinator) return toolError("[subsession-error] sub-sessions are not available in this run");

  const subSessionId = requireSubSessionId(args, FINALIZE_SUBSESSION_TOOL);
  if (!subSessionId.ok) return toolError(subSessionId.reason);

  const finalStatus =
    args.finalStatus === "done" || args.finalStatus === "error" ? args.finalStatus : undefined;
  const snapshot = coordinator.finalize(ctx.session.sessionId, subSessionId.value, finalStatus);
  if (!snapshot) {
    return toolError(`[subsession-error] unknown subSessionId "${subSessionId.value}" for this session`);
  }
  return {
    isError: false,
    content: snapshotJson(snapshot),
    event: { type: "subsession-finalize", data: { subSessionId: subSessionId.value, status: snapshot.status } },
  };
}

// ---------------------------------------------------------------------------

function requireCoordinator(ctx: ToolContext): SubSessionCoordinator | undefined {
  return ctx.coordinator;
}

function requireSubSessionId(
  args: Record<string, unknown>,
  toolName: string
): { ok: true; value: string } | { ok: false; reason: string } {
  const subSessionId = args.subSessionId;
  if (typeof subSessionId !== "string" || subSessionId.length === 0) {
    return { ok: false, reason: `[subsession-error] ${toolName}.subSessionId must be a non-empty string` };
  }
  return { ok: true, value: subSessionId };
}

function snapshotJson(snapshot: SubSessionSnapshot): string {
  return JSON.stringify(snapshot, null, 2);
}

// ---------------------------------------------------------------------------
// Descriptors
// ---------------------------------------------------------------------------

function createDescriptor(): ToolDescriptor {
  return {
    name: CREATE_SUBSESSION_TOOL,
    description: [
      "Spawn an autonomous SUB-SESSION to pursue an independent sub-goal.",
      "The child runs the orchestrator loop on its own, driving toward the",
      "given intent until the evaluator is satisfied — it does NOT wait for a",
      "user prompt. Use this to delegate a self-contained chunk of work so you",
      "can continue in parallel.",
      "",
      'Returns IMMEDIATELY with a snapshot whose status is usually "running".',
      "Poll its progress with get_subsession_status, and end it (cancelling it",
      "if still running) with finalize_subsession. The child shares this",
      "session's workspace sandbox.",
      "",
      "GUARDED: a request whose intent matches an active child reuses that",
      "child instead of duplicating it, and there is a small cap on how many",
      "children may run at once — call list_subsessions first to see what is",
      "already in flight, and finalize_subsession to free a slot.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      required: ["intent"],
      properties: {
        intent: {
          type: "string",
          description: "The goal the sub-session must resolve, phrased as you would a user request.",
        },
        context: {
          type: "string",
          description:
            "Optional standing context seeded for the child before the intent (background, constraints).",
        },
      },
    },
  };
}

function statusDescriptor(): ToolDescriptor {
  return {
    name: SUBSESSION_STATUS_TOOL,
    description: [
      "Get a snapshot of a sub-session you spawned: its status",
      "(running/done/error/archived), and — once finished — its result or",
      "error. If you poll and the status has not changed since your last check,",
      "this call deliberately backs off (waits, with growing delay) before",
      "returning — so do other useful work between checks rather than polling",
      "in a tight loop.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      required: ["subSessionId"],
      properties: {
        subSessionId: {
          type: "string",
          description: "The id returned by create_subsession.",
        },
      },
    },
  };
}

function listDescriptor(): ToolDescriptor {
  return {
    name: LIST_SUBSESSIONS_TOOL,
    description: [
      "List the sub-sessions currently active for this session — each with its",
      "id, intent, and status. Use this to see how many you have running and",
      "whether the work you are about to delegate is already in flight, before",
      "calling create_subsession. Takes no arguments.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {},
    },
  };
}

function finalizeDescriptor(): ToolDescriptor {
  return {
    name: FINALIZE_SUBSESSION_TOOL,
    description: [
      "Finalize a sub-session: cancel it if still running, record a final",
      "status, and archive it (dereferencing it from this session). Idempotent.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      required: ["subSessionId"],
      properties: {
        subSessionId: {
          type: "string",
          description: "The id returned by create_subsession.",
        },
        finalStatus: {
          type: "string",
          enum: ["done", "error"],
          description:
            "Optional outcome to record when finalizing a child that has not finished on its own.",
        },
      },
    },
  };
}
