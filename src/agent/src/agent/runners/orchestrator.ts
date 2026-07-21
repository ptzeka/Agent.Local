import { ScopedToolClient } from "../scoped-tool-client.js";
import type { ChatMessage } from "../providers/provider.js";
import { DispatchTracker } from "../synthetic-mcp/dispatch-tracker.js";
import type { TurnBindable, TurnBinding } from "../synthetic-mcp/types.js";
import { TURN_RESULT_SERVER_NAME } from "../synthetic-mcp/turn-result-server.js";
import { TurnResultCapture } from "../synthetic-mcp/turn-result-tools.js";
import type { ReportedTurnResult } from "../synthetic-mcp/types.js";
import type { RunnerContext } from "./middleware/runner-middleware.js";
import { Eventing } from "@agent-local/common/eventing";
import { Turn } from "./middleware/turn.js";
import { SystemMessagesRound } from "./middleware/systemmessagesround.js";
import { SummarizeRound } from "./middleware/summarizeround.js";
import { PromptRound } from "./middleware/promptround.js";
import { MemoryRound } from "./middleware/memoryround.js";
import { ModelRound } from "./middleware/modelround.js";
import { ResponseRound } from "./middleware/responseround.js";
import { EvaluatorRound } from "./middleware/evaluatorround.js";
import { ToolRound } from "./middleware/toolround.js";
import type { ModelRegistry } from "../registries/model-registry.js";
import type { ModelsFile } from "../registries/configuration-registry.js";
import { OrchestratorEventTypes } from "./runner-events.js";

// re-export for backwards compatibility
export type { OrchestratorEvent, OrchestratorListener } from "./runner-events.js";

export interface RunResult {
  finalMessage: ChatMessage;
  iterations: number;
  dispatches: number;
  // "satisfied" accepted, "awaiting-input" ended on a clarification question (no work done — distinct so headless can't read it as success),
  // "capped" hit the iteration bound, "failed" judged unrecoverable; drives the headless exit code
  outcome: "satisfied" | "awaiting-input" | "capped" | "failed";
  // the agent's structured verdict from report_result on a dispatched turn; absent when the tool wasn't mounted
  // or wasn't called (interactive, capped, or system-failed turns) — the dispatch boundary fills a fallback then
  reported?: ReportedTurnResult;
}

// narrow contract satisfied structurally by Orchestrator, so the manager stays decoupled and construction acyclic
export interface SessionRunner {
  run(ctx: RunnerContext): Promise<RunResult>;
}

// drives the agentic loop for any role; the role selects model, visible tools, prompt, and iteration cap
// STATELESS: holds only its role; per-turn state lives in the TurnState the rounds share (see middleware/)
// orchestrator role gates on the evaluator; executor role ends on the first tool-free response
export class Orchestrator {
  constructor(private readonly role: string) {}

  // runs one user turn end-to-end: builds the TurnState, then drives the round list per iteration;
  // rounds flush per round so a crash loses at most the round in flight, with finalize() backstopping the tail
  public async run(ctx: RunnerContext): Promise<RunResult> {
    // the turn bus is minted+chained by AgentRuntime.beginTurn; the runner only publishes onto it
    const turnEvents = ctx.events;
    const modelsRegistry = ctx.runtime.getModelsRegistry();
    const mcpRegistry = ctx.runtime.getMcpClientRegistry();
    const providersRegistry = ctx.runtime.getProvidersRegistry();
    const conversation = ctx.runtime.getConversation();

    const config = await ctx.runtime.getConfigurationRegistry().getModelsConfiguration()!;

    // no opening append: every user message arrives through the inbox drain inside the loop.
    // the context snapshot, history compaction, and memory recall all load at turn start via the
    // first rounds (SystemMessagesRound / SummarizeRound / MemoryRound), not here
    const provider = providersRegistry.getProvider(modelsRegistry.getProviderForRole(this.role));

    // structured mode IS "is turnresult mounted" — driven solely by the role's whitelist (only workflow-orchestrator
    // lists it), like the executor/memomcp seams. the executor reports to its parent, not a workflow, so it's excluded.
    // the sink is minted regardless so the post-round check is uniform; the bind pass below wires it in.
    const structuredMode = !!mcpRegistry.getClient(TURN_RESULT_SERVER_NAME) && this.role !== "executor";
    const resultSink = new TurnResultCapture();

    const scopedClients = ScopedToolClient.forRole(mcpRegistry, modelsRegistry, this.role);
    const visibleTools = scopedClients.listTools();

    const maxDispatches = config.orchestration.maxExecutorDispatchesPerTurn!;
    const checkInterval = config.orchestration.validatorCheckIntervalDispatches ?? 0;
    const tracker = new DispatchTracker(maxDispatches, checkInterval);
    const maxIterations = this.getIterationsMax(modelsRegistry, config);
    // ONE per-turn seam: servers register once at build; those holding turn state take it here via bindTurn.
    // skipped for the executor role: its sub-run doesn't dispatch or report, so nothing needs binding there.
    if (this.role !== "executor") {
      // chained under the turn so what bound servers publish bubbles up
      const mcpClientEvents = new Eventing();
      turnEvents.add(mcpClientEvents);
      const binding: TurnBinding = { signal: ctx.signal, tracker, events: mcpClientEvents, resultSink };
      for (const client of mcpRegistry.listClients()) {
        const bindable = client as unknown as Partial<TurnBindable>;
        if (typeof bindable.bindTurn === "function") bindable.bindTurn(binding);
      }
    }
    
    turnEvents.publish(OrchestratorEventTypes.START, {
      orchestratorModel: provider.modelId,
      orchestratorTools: visibleTools,
      readToolCount: visibleTools.length,
      maxIterations: maxIterations
    });

    // ONE turn per prompt: PromptRound pulls a single queued prompt on the first iteration and the
    // turn carries that request across iterations; the pump replays this run for the next queued prompt
    const turn = new Turn(ctx, {
      role: this.role,
      provider,
      scopedClients,
      visibleTools,
      tracker,
      resultSink,
      conversation,
      config,
      structuredMode,
      streaming: ctx.runtime.isStreamOutputEnabled(),
      rounds: [
        new SystemMessagesRound(ctx),
        new SummarizeRound(ctx),
        new PromptRound(ctx),
        new MemoryRound(ctx),
        new ModelRound(ctx),
        new ResponseRound(ctx),
        new EvaluatorRound(ctx),
        new ToolRound(ctx),
      ],
    });

    // the iteration loop lives here, not in the Turn: each pass re-runs the round list once,
    // and a round ends the turn (done), restarts the iteration, or falls through to the pass end
    for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
      if (ctx.signal.aborted) {
        throw new Error("turn aborted: user requested stop");
      }
      turn.iteration = iteration;
      turnEvents.publish(OrchestratorEventTypes.ITERATION, { iteration, max: maxIterations });

      const outcome = await turn.runAsync();
      if (outcome.kind === "done") return outcome.result;
    }

    const truncationNotice: ChatMessage = {
      role: "assistant",
      content:
        `ORCHESTRATOR: hit iteration cap of ${maxIterations} without a final answer. ` +
        "Try a narrower request or raise maxOrchestratorIterations in models.json.",
    };
    conversation.append(truncationNotice);
    ctx.events.publish(OrchestratorEventTypes.WARNING, {
      message: `${this.role} hit iteration cap`,
      iterations: maxIterations,
    });
    return {
      finalMessage: truncationNotice,
      iterations: maxIterations,
      dispatches: tracker.count,
      outcome: "capped",
    };
  }

  private getIterationsMax(modelsRegistry: ModelRegistry, config: ModelsFile): number {
    // the model's own iterationCap wins; absent it, fall back to the role default
    const roleIterationDefault =
      this.role === "executor"
        ? (config.orchestration.maxExecutorIterationsPerAsk ?? 6)
        : (config.orchestration.maxOrchestratorIterations ?? 16);
    const modelName = modelsRegistry.getProviderForRole(this.role);
    const maxIterations = modelsRegistry.getIterationCapForModel(modelName) ?? roleIterationDefault;
    return maxIterations;
  }
}
