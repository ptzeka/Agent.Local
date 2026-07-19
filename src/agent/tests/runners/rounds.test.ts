import { describe, expect, jest, test } from "@jest/globals";

import { Eventing } from "@agent-local/common/eventing";
import type { Conversation } from "../../src/agent/conversation/conversation.js";
import type {
  ChatMessage,
  ChatResponse,
  LLMProvider,
  ToolCall,
} from "../../src/agent/providers/provider.js";
import type { ModelsFile } from "../../src/agent/registries/configuration-registry.js";
import type { ScopedToolClient } from "../../src/agent/scoped-tool-client.js";
import type { AgentRuntimeQueryable } from "../../src/agent/runtime/types.js";
import { DispatchTracker } from "../../src/agent/synthetic-mcp/dispatch-tracker.js";
import { TurnResultCapture } from "../../src/agent/synthetic-mcp/turn-result-tools.js";
import type { IRound } from "../../src/agent/runners/middleware/iround.js";
import { MemoryRound } from "../../src/agent/runners/middleware/memoryround.js";
import { ModelRound } from "../../src/agent/runners/middleware/modelround.js";
import { PromptRound } from "../../src/agent/runners/middleware/promptround.js";
import { SystemMessagesRound } from "../../src/agent/runners/middleware/systemmessagesround.js";
import { SummarizeRound } from "../../src/agent/runners/middleware/summarizeround.js";
import type { ContextSnapshot } from "../../src/agent/context/context-loader.js";
import { ResponseRound } from "../../src/agent/runners/middleware/responseround.js";
import { EvaluatorRound } from "../../src/agent/runners/middleware/evaluatorround.js";
import { ToolRound } from "../../src/agent/runners/middleware/toolround.js";
import type { RunnerContext } from "../../src/agent/runners/middleware/runner-middleware.js";
import { Turn } from "../../src/agent/runners/middleware/turn.js";
import { OrchestratorEventTypes } from "../../src/agent/runners/runner-events.js";

// Each round is exercised in isolation against a hand-built Turn: the harness fakes only the
// seams a round touches (conversation, provider, scoped clients, runtime registries) and records
// every published event, so a test asserts the round's outcome AND its side effects on the turn.

interface FakeConversation {
  messages: ChatMessage[];
  append: (...msgs: ChatMessage[]) => void;
  flush: jest.Mock;
  getMessages: () => ChatMessage[];
  replaceAll: jest.Mock;
}

function makeConversation(): FakeConversation {
  const messages: ChatMessage[] = [];
  return {
    messages,
    append: (...msgs: ChatMessage[]) => {
      messages.push(...msgs);
    },
    flush: jest.fn(async () => {}),
    getMessages: () => messages,
    replaceAll: jest.fn(async (next: ChatMessage[]) => {
      messages.length = 0;
      messages.push(...next);
    }),
  };
}

function makeConfig(overrides: Partial<ModelsFile["orchestration"]> = {}): ModelsFile {
  return {
    models: {},
    roles: {},
    orchestration: {
      evaluatorEnabled: false,
      evaluatorTemperature: 0,
      ...overrides,
    },
    // 0 disables the short-request passthrough so the fake judge always runs when enabled
    summaryWordThreshold: 0,
  };
}

interface HarnessOptions {
  inbox?: string[];
  // the memomcp client returned by the registry; null hides the server entirely
  memoryClient?: { callTool: jest.Mock } | null;
  // what the fake evaluator-judge provider replies (parsed by the real Evaluator)
  evaluatorReply?: string;
  chatResponse?: ChatResponse;
  chatError?: Error;
  signal?: AbortSignal;
}

// the mutable knobs a test seeds after construction, plus the constructor options it overrides
interface TurnOverrides {
  role?: string;
  structuredMode?: boolean;
  tracker?: DispatchTracker;
  maxIterations?: number;
  // the raw snapshot the Turn carries for SystemMessagesRound to assemble
  context?: ContextSnapshot;
  // convenience: installs the built context prefix directly (bypassing SystemMessagesRound)
  contextMessages?: ChatMessage[];
  rounds?: IRound[];
  turnRequest?: string | null;
  recalled?: boolean;
  toolCallsMade?: number;
  iteration?: number;
  assistantMessage?: ChatMessage | null;
  toolCalls?: ToolCall[];
}

interface Harness {
  ctx: RunnerContext;
  conversation: FakeConversation;
  events: Array<{ type: string; payload: Record<string, unknown> }>;
  chat: jest.Mock;
  callTool: jest.Mock;
  config: ModelsFile;
  makeTurn: (overrides?: TurnOverrides) => Turn;
}

function makeHarness(opts: HarnessOptions = {}): Harness {
  const conversation = makeConversation();
  const eventBus = new Eventing();
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  eventBus.subscribe((event) => events.push(event as { type: string; payload: Record<string, unknown> }));

  const chat = jest.fn(
    async (): Promise<ChatResponse> => {
      if (opts.chatError) throw opts.chatError;
      return opts.chatResponse ?? { message: { role: "assistant", content: "answer" } };
    }
  );
  const provider = {
    providerName: "fake",
    modelId: "fake-model",
    supportsNativeTools: true,
    chat,
  } as unknown as LLMProvider;

  const evaluatorChat = jest.fn(async (): Promise<ChatResponse> => ({
    message: { role: "assistant", content: opts.evaluatorReply ?? "EVALUATOR: SATISFIED looks done" },
  }));
  const evaluatorProvider = { providerName: "judge", modelId: "judge-model", chat: evaluatorChat };

  const callTool = jest.fn(async () => ({ content: "tool-ok", isError: false }));
  const scopedClients = { callTool, listTools: () => [] } as unknown as ScopedToolClient;

  const config = makeConfig();
  const runtime = {
    getMcpClientRegistry: () => ({
      getClient: (name: string) => (name === "memomcp" ? opts.memoryClient ?? null : null),
    }),
    getModelsRegistry: () => ({
      getAnchorText: (request: string) => `ANCHOR: ${request}`,
      getProviderForRole: () => "judge",
    }),
    getProvidersRegistry: () => ({ getProvider: () => evaluatorProvider }),
    getConfigurationRegistry: () => ({ getModelsConfiguration: async () => config }),
    // the summarizer role reuses the judge provider; these two seams are all it additionally reads
    getContextLoader: () => ({ getContextSnapshot: async () => ({ systemPrompt: "summarize this" }) }),
    getSession: () => ({ contextHashes: { summarizer: "h" } }),
  } as unknown as AgentRuntimeQueryable;

  const inbox = [...(opts.inbox ?? [])];
  const ctx: RunnerContext = {
    session: { sessionId: "s1" },
    events: eventBus,
    signal: opts.signal ?? new AbortController().signal,
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    registry: {},
    runtime,
    pullInjectedPrompts: () => inbox.splice(0),
  } as unknown as RunnerContext;

  const makeTurn = (overrides: TurnOverrides = {}): Turn => {
    const turn = new Turn(ctx, {
      role: overrides.role ?? "orchestrator",
      provider,
      scopedClients,
      visibleTools: [],
      tracker: overrides.tracker ?? new DispatchTracker(10, 0),
      resultSink: new TurnResultCapture(),
      conversation: conversation as unknown as Conversation,
      config,
      structuredMode: overrides.structuredMode ?? false,
      temperature: 0,
      streaming: false,
      maxIterations: overrides.maxIterations ?? 5,
      context: overrides.context ?? ({ systemPrompt: "", projectContext: "" } as ContextSnapshot),
      rounds: overrides.rounds ?? [],
    });
    turn.turnRequest = overrides.turnRequest ?? null;
    turn.recalled = overrides.recalled ?? false;
    turn.toolCallsMade = overrides.toolCallsMade ?? 0;
    turn.iteration = overrides.iteration ?? 1;
    turn.assistantMessage = overrides.assistantMessage ?? null;
    turn.toolCalls = overrides.toolCalls ?? [];
    // seed the working-set prefix directly when a test doesn't exercise SystemMessagesRound itself
    if (overrides.contextMessages) turn.setContextMessages(overrides.contextMessages);
    return turn;
  };

  return { ctx, conversation, events, chat, callTool, config, makeTurn };
}

function eventTypes(h: Harness): string[] {
  return h.events.map((event) => event.type);
}

// ---------------------------------------------------------------------------
// SystemMessagesRound
// ---------------------------------------------------------------------------

describe("SystemMessagesRound", () => {
  test("builds the context prefix and seeds it ahead of the conversation in the working set", async () => {
    const h = makeHarness();
    h.conversation.messages.push({ role: "user", content: "prior" });
    const turn = h.makeTurn({
      context: { projectContext: "proj direction", systemPrompt: "sys" } as ContextSnapshot,
    });

    const outcome = await new SystemMessagesRound(h.ctx).runAsync(turn);

    expect(outcome.kind).toBe("continue");
    expect(turn.contextBuilt).toBe(true);
    expect(turn.workingMessages).toEqual([
      { role: "system", content: expect.stringContaining("proj direction") },
      { role: "system", content: "sys" },
      { role: "user", content: "prior" },
    ]);
  });

  test("runs once per turn: a second pass leaves the appended turn work intact", async () => {
    const h = makeHarness();
    const turn = h.makeTurn({ context: { projectContext: "", systemPrompt: "sys" } as ContextSnapshot });
    await new SystemMessagesRound(h.ctx).runAsync(turn);
    turn.append({ role: "assistant", content: "work" });

    const outcome = await new SystemMessagesRound(h.ctx).runAsync(turn);

    // the guard blocks a reseed that would drop the appended work off the tail
    expect(outcome.kind).toBe("continue");
    expect(turn.workingMessages).toEqual([
      { role: "system", content: "sys" },
      { role: "assistant", content: "work" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// SummarizeRound
// ---------------------------------------------------------------------------

describe("SummarizeRound", () => {
  test("under the threshold it no-ops: history untouched, no summarizer call, no events", async () => {
    const h = makeHarness();
    h.config.orchestration.summarizeAtMessages = 30;
    const turn = h.makeTurn({ turnRequest: "the ask" });

    const outcome = await new SummarizeRound(h.ctx).runAsync(turn);

    expect(outcome.kind).toBe("continue");
    expect(h.conversation.replaceAll).not.toHaveBeenCalled();
    expect(h.events).toHaveLength(0);
  });

  test("over the threshold it compacts the prefix, keeps the tail, and reseeds the working set", async () => {
    const h = makeHarness({ evaluatorReply: "condensed recap" });
    for (let i = 0; i < 6; i += 1) h.conversation.messages.push({ role: "user", content: `m${i}` });
    h.config.orchestration.summarizeAtMessages = 3;
    h.config.orchestration.summarizerKeepLastN = 2;
    const turn = h.makeTurn({
      turnRequest: "the ask",
      contextMessages: [{ role: "system", content: "ctx" }],
    });

    const outcome = await new SummarizeRound(h.ctx).runAsync(turn);

    expect(outcome.kind).toBe("continue");
    // history becomes [summary, ...last 2 kept verbatim]
    expect(h.conversation.replaceAll).toHaveBeenCalledTimes(1);
    expect(h.conversation.messages).toHaveLength(3);
    expect(h.conversation.messages[0]!.content).toContain("condensed recap");
    expect(h.conversation.messages.slice(1)).toEqual([
      { role: "user", content: "m4" },
      { role: "user", content: "m5" },
    ]);
    // the current turn's model set is rebuilt from the compacted history, not the old one
    expect(turn.workingMessages).toEqual([
      { role: "system", content: "ctx" },
      ...h.conversation.messages,
    ]);
    expect(eventTypes(h)).toEqual([
      OrchestratorEventTypes.SUMMARIZATION_START,
      OrchestratorEventTypes.SUMMARIZATION,
    ]);
  });
});

// ---------------------------------------------------------------------------
// PromptRound
// ---------------------------------------------------------------------------

describe("PromptRound", () => {
  test("drains the inbox into conversation + working set and sets the turn request", async () => {
    const h = makeHarness({ inbox: ["do the thing", "and this too"] });
    const turn = h.makeTurn();

    const outcome = await new PromptRound(h.ctx).runAsync(turn);

    expect(outcome.kind).toBe("continue");
    expect(turn.turnRequest).toBe("do the thing\nand this too");
    expect(turn.workingMessages.map((message) => message.content)).toEqual([
      "do the thing",
      "and this too",
    ]);
    expect(h.conversation.messages).toHaveLength(2);
    expect(eventTypes(h)).toEqual([
      OrchestratorEventTypes.INJECTED_INPUT,
      OrchestratorEventTypes.INJECTED_INPUT,
    ]);
  });

  test("a wake with nothing queued settles without a model call: done/satisfied with zero iterations", async () => {
    const h = makeHarness({ inbox: [] });
    const turn = h.makeTurn();

    const outcome = await new PromptRound(h.ctx).runAsync(turn);

    expect(outcome).toMatchObject({
      kind: "done",
      result: { outcome: "satisfied", iterations: 0 },
    });
    expect(h.conversation.messages).toHaveLength(0);
  });

  test("an empty drain mid-turn keeps going: the first request anchors the whole turn", async () => {
    const h = makeHarness({ inbox: [] });
    const turn = h.makeTurn({ turnRequest: "original ask", iteration: 3 });

    const outcome = await new PromptRound(h.ctx).runAsync(turn);

    expect(outcome.kind).toBe("continue");
    expect(turn.turnRequest).toBe("original ask");
  });
});

// ---------------------------------------------------------------------------
// MemoryRound
// ---------------------------------------------------------------------------

describe("MemoryRound", () => {
  test("injects recalled memories as a transient system message — working set only, never the transcript", async () => {
    const memoryClient = { callTool: jest.fn(async () => ({ content: "remembered facts", isError: false })) };
    const h = makeHarness({ memoryClient });
    const turn = h.makeTurn({ turnRequest: "the ask" });

    const outcome = await new MemoryRound(h.ctx).runAsync(turn);

    expect(outcome.kind).toBe("continue");
    expect(turn.recalled).toBe(true);
    expect(memoryClient.callTool).toHaveBeenCalledWith("recall", { query: "the ask" }, h.ctx.signal);
    expect(turn.workingMessages).toEqual([
      { role: "system", content: expect.stringContaining("remembered facts") },
    ]);
    expect(h.conversation.messages).toHaveLength(0);
    expect(eventTypes(h)).toEqual([
      OrchestratorEventTypes.RECALL_START,
      OrchestratorEventTypes.RECALL_FINALIZE,
    ]);
  });

  test("runs once per turn: a second pass with recalled=true never touches the client", async () => {
    const memoryClient = { callTool: jest.fn(async () => ({ content: "x", isError: false })) };
    const h = makeHarness({ memoryClient });
    const turn = h.makeTurn({ turnRequest: "the ask", recalled: true });

    const outcome = await new MemoryRound(h.ctx).runAsync(turn);

    expect(outcome.kind).toBe("continue");
    expect(memoryClient.callTool).not.toHaveBeenCalled();
  });

  test("no-ops when memomcp is not mounted (executor role / no collection)", async () => {
    const h = makeHarness({ memoryClient: null });
    const turn = h.makeTurn({ turnRequest: "the ask" });

    const outcome = await new MemoryRound(h.ctx).runAsync(turn);

    expect(outcome.kind).toBe("continue");
    expect(turn.workingMessages).toHaveLength(0);
    expect(h.events).toHaveLength(0);
  });

  test("fails open: a recall error warns and continues instead of blocking the turn", async () => {
    const memoryClient = {
      callTool: jest.fn(async () => {
        throw new Error("store offline");
      }),
    };
    const h = makeHarness({ memoryClient });
    const turn = h.makeTurn({ turnRequest: "the ask" });

    const outcome = await new MemoryRound(h.ctx).runAsync(turn);

    expect(outcome.kind).toBe("continue");
    expect(turn.workingMessages).toHaveLength(0);
    expect(eventTypes(h)).toEqual([
      OrchestratorEventTypes.RECALL_START,
      OrchestratorEventTypes.WARNING,
    ]);
  });
});

// ---------------------------------------------------------------------------
// ModelRound
// ---------------------------------------------------------------------------

describe("ModelRound", () => {
  test("anchors the request last, appends the reply everywhere, and hands it to the next rounds", async () => {
    const response: ChatResponse = {
      message: { role: "assistant", content: "the answer" },
      usage: { inputTokens: 1 } as never,
    };
    const h = makeHarness({ chatResponse: response });
    const turn = h.makeTurn({
      turnRequest: "the ask",
      contextMessages: [{ role: "user", content: "the ask" }],
    });

    const outcome = await new ModelRound(h.ctx).runAsync(turn);

    expect(outcome.kind).toBe("continue");
    const sentMessages = h.chat.mock.calls[0]![0] as ChatMessage[];
    expect(sentMessages.at(-1)).toEqual({ role: "system", content: "ANCHOR: the ask" });
    expect(turn.assistantMessage).toMatchObject({ role: "assistant", content: "the answer" });
    expect(turn.toolCalls).toEqual([]);
    expect(h.conversation.messages.at(-1)).toBe(turn.assistantMessage);
    expect(turn.workingMessages.at(-1)).toBe(turn.assistantMessage);
    expect(eventTypes(h)).toEqual([OrchestratorEventTypes.ITERATION, OrchestratorEventTypes.MESSAGE]);
    // usage is stamped with the session so the spend stays attributable downstream
    expect((response.usage as never as { sessionId?: string }).sessionId).toBe("s1");
  });

  test("native tool calls land in turn.toolCalls for the rounds below", async () => {
    const calls = [{ id: "c1", name: "fs_read", arguments: { path: "a" } }];
    const h = makeHarness({
      chatResponse: { message: { role: "assistant", content: "", toolCalls: calls } },
    });
    const turn = h.makeTurn({ turnRequest: "the ask" });

    await new ModelRound(h.ctx).runAsync(turn);

    expect(turn.toolCalls).toEqual(calls);
  });

  test("a provider failure surfaces as a thrown error naming provider, model, and iteration", async () => {
    const h = makeHarness({ chatError: new Error("rate limited") });
    const turn = h.makeTurn({ turnRequest: "the ask", iteration: 4 });

    await expect(new ModelRound(h.ctx).runAsync(turn)).rejects.toThrow(
      "Orchestrator (fake:fake-model) failed at iteration 4: rate limited"
    );
  });
});

// ---------------------------------------------------------------------------
// ResponseRound
// ---------------------------------------------------------------------------

describe("ResponseRound", () => {
  const reply: ChatMessage = { role: "assistant", content: "done it" };

  test("passes through when the reply carries tool calls", async () => {
    const h = makeHarness();
    const turn = h.makeTurn({
      turnRequest: "the ask",
      assistantMessage: reply,
      toolCalls: [{ id: "c1", name: "t", arguments: {} }],
    });

    const outcome = await new ResponseRound(h.ctx).runAsync(turn);

    expect(outcome.kind).toBe("continue");
    expect(h.events).toHaveLength(0);
  });

  test("executor that never called a tool fails the dispatch — prose alone must not bank as success", async () => {
    const h = makeHarness();
    const turn = h.makeTurn({
      role: "executor",
      turnRequest: "the ask",
      assistantMessage: reply,
      toolCallsMade: 0,
    });

    const outcome = await new ResponseRound(h.ctx).runAsync(turn);

    expect(outcome).toMatchObject({ kind: "done", result: { outcome: "failed" } });
    expect(h.conversation.messages.at(-1)!.content).toContain("SYSTEM-FAILURE");
    expect(eventTypes(h)).toContain(OrchestratorEventTypes.SYSTEM_FAILURE);
  });

  test("executor with tool evidence settles on its first tool-free reply — no evaluator gate", async () => {
    const h = makeHarness();
    const turn = h.makeTurn({
      role: "executor",
      turnRequest: "the ask",
      assistantMessage: reply,
      toolCallsMade: 2,
      iteration: 3,
    });

    const outcome = await new ResponseRound(h.ctx).runAsync(turn);

    expect(outcome).toMatchObject({
      kind: "done",
      result: { outcome: "satisfied", finalMessage: reply, iterations: 3 },
    });
    expect(h.events).toHaveLength(0);
  });

  test("structured mode nudges for the mandated report_result and restarts the iteration", async () => {
    const h = makeHarness();
    const turn = h.makeTurn({
      turnRequest: "the ask",
      assistantMessage: reply,
      structuredMode: true,
    });

    const outcome = await new ResponseRound(h.ctx).runAsync(turn);

    expect(outcome.kind).toBe("next-iteration");
    const nudge = h.conversation.messages.at(-1)!;
    expect(nudge.role).toBe("user");
    expect(nudge.content).toContain("report_result");
    expect(nudge.content).toContain("«the ask»");
    expect(turn.workingMessages.at(-1)).toBe(nudge);
    expect(h.conversation.flush).toHaveBeenCalledTimes(1);
  });

  test("hands the orchestrator's tool-free, non-structured reply down to EvaluatorRound", async () => {
    const h = makeHarness();
    const turn = h.makeTurn({ turnRequest: "the ask", assistantMessage: reply });

    const outcome = await new ResponseRound(h.ctx).runAsync(turn);

    expect(outcome.kind).toBe("continue");
    expect(h.events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// EvaluatorRound
// ---------------------------------------------------------------------------

describe("EvaluatorRound", () => {
  const reply: ChatMessage = { role: "assistant", content: "done it" };

  test("with the evaluator disabled the first tool-free reply settles as satisfied", async () => {
    const h = makeHarness();
    const turn = h.makeTurn({ turnRequest: "the ask", assistantMessage: reply });

    const outcome = await new EvaluatorRound(h.ctx).runAsync(turn);

    expect(outcome).toMatchObject({ kind: "done", result: { outcome: "satisfied" } });
  });

  test("an unsatisfied judge verdict nudges with the verbatim request and restarts the iteration", async () => {
    const h = makeHarness({ evaluatorReply: "EVALUATOR: UNSATISFIED nothing actually ran" });
    const turn = h.makeTurn({ turnRequest: "the ask", assistantMessage: reply });
    h.config.orchestration.evaluatorEnabled = true;

    const outcome = await new EvaluatorRound(h.ctx).runAsync(turn);

    expect(outcome.kind).toBe("next-iteration");
    expect(h.conversation.messages.at(-1)!.content).toContain("off track — nothing actually ran");
    expect(h.conversation.messages.at(-1)!.content).toContain("«the ask»");
    expect(eventTypes(h)).toEqual([
      OrchestratorEventTypes.EVALUATION_START,
      OrchestratorEventTypes.EVALUATION_VERDICT,
    ]);
  });
});

// ---------------------------------------------------------------------------
// ToolRound
// ---------------------------------------------------------------------------

describe("ToolRound", () => {
  const calls = [
    { id: "c1", name: "fs_read", arguments: { path: "a" } },
    { id: "c2", name: "fs_write", arguments: { path: "b" } },
  ];

  test("executes every call, appends paired tool messages, counts evidence, and flushes the round", async () => {
    const h = makeHarness();
    const turn = h.makeTurn({ turnRequest: "the ask", toolCalls: calls });

    const outcome = await new ToolRound(h.ctx).runAsync(turn);

    expect(outcome.kind).toBe("continue");
    expect(h.callTool).toHaveBeenCalledTimes(2);
    expect(turn.toolCallsMade).toBe(2);
    expect(h.conversation.messages).toEqual(turn.workingMessages);
    expect(h.conversation.messages.map((message) => message.toolCallId)).toEqual(["c1", "c2"]);
    expect(h.conversation.flush).toHaveBeenCalledTimes(1);
  });

  test("a failing tool result is wrapped as [tool-error] instead of aborting the turn", async () => {
    const h = makeHarness();
    h.callTool.mockResolvedValueOnce({ content: "boom", isError: true } as never);
    const turn = h.makeTurn({ turnRequest: "the ask", toolCalls: [calls[0]!] });

    const outcome = await new ToolRound(h.ctx).runAsync(turn);

    expect(outcome.kind).toBe("continue");
    expect(h.conversation.messages[0]!.content).toBe("[tool-error] boom");
  });

  test("a landed report_result terminates the turn with the self-describing envelope, fail failing closed", async () => {
    const h = makeHarness();
    const turn = h.makeTurn({ turnRequest: "the ask", toolCalls: [calls[0]!], iteration: 2 });
    turn.resultSink.set({ status: "fail", result: { reason: "could not" } } as never);

    const outcome = await new ToolRound(h.ctx).runAsync(turn);

    expect(outcome).toMatchObject({
      kind: "done",
      result: { outcome: "failed", iterations: 2, reported: { status: "fail" } },
    });
    const envelope = JSON.parse(h.conversation.messages.at(-1)!.content);
    expect(envelope).toMatchObject({ status: "fail", input: "the ask" });
    expect(eventTypes(h)).toContain(OrchestratorEventTypes.MESSAGE);
  });

  test("the periodic progress gate nudges off-track work without ending the turn", async () => {
    const h = makeHarness({ evaluatorReply: "EVALUATOR: UNSATISFIED going in circles" });
    const tracker = new DispatchTracker(10, 1);
    tracker.recordSuccess("sig"); // one dispatch since the last check → the gate is due
    const turn = h.makeTurn({ turnRequest: "the ask", toolCalls: [calls[0]!], tracker });
    h.config.orchestration.evaluatorEnabled = true;

    const outcome = await new ToolRound(h.ctx).runAsync(turn);

    expect(outcome.kind).toBe("continue");
    expect(h.conversation.messages.at(-1)!.content).toContain("off track — going in circles");
    expect(h.conversation.flush).toHaveBeenCalledTimes(1);
  });

  test("a failed verdict at the periodic gate ends the turn", async () => {
    const h = makeHarness({ evaluatorReply: "EVALUATOR: FAILED stuck for good" });
    const tracker = new DispatchTracker(10, 1);
    tracker.recordSuccess("sig");
    const turn = h.makeTurn({ turnRequest: "the ask", toolCalls: [calls[0]!], tracker });
    h.config.orchestration.evaluatorEnabled = true;

    const outcome = await new ToolRound(h.ctx).runAsync(turn);

    expect(outcome).toMatchObject({ kind: "done", result: { outcome: "failed" } });
  });

  test("an aborted signal stops before any tool runs", async () => {
    const controller = new AbortController();
    controller.abort();
    const h = makeHarness({ signal: controller.signal });
    const turn = h.makeTurn({ turnRequest: "the ask", toolCalls: calls });

    await expect(new ToolRound(h.ctx).runAsync(turn)).rejects.toThrow("turn aborted");
    expect(h.callTool).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Turn.runAsync
// ---------------------------------------------------------------------------

describe("Turn.runAsync", () => {
  const stub = (outcomes: Array<"continue" | "next-iteration">, log: string[], name: string): IRound => {
    let call = 0;
    return {
      runAsync: async () => {
        log.push(`${name}#${call}`);
        return { kind: outcomes[Math.min(call++, outcomes.length - 1)]! };
      },
    };
  };

  test("runs rounds in order and returns the first done result", async () => {
    const h = makeHarness();
    const log: string[] = [];
    const finisher: IRound = {
      runAsync: async (turn) => {
        log.push("finisher");
        return turn.settle({ role: "assistant", content: "final" }, "satisfied");
      },
    };
    const turn = h.makeTurn({ rounds: [stub(["continue"], log, "a"), finisher, stub(["continue"], log, "never")] });

    const result = await turn.runAsync();

    expect(result).toMatchObject({ outcome: "satisfied", iterations: 1 });
    expect(log).toEqual(["a#0", "finisher"]); // the round below the finisher never ran
  });

  test("next-iteration skips the rounds below and advances the iteration counter", async () => {
    const h = makeHarness();
    const log: string[] = [];
    const skipOnce = stub(["next-iteration", "continue"], log, "skip");
    const after: IRound = {
      runAsync: async (turn) => {
        log.push(`after@${turn.iteration}`);
        return turn.settle({ role: "assistant", content: "final" }, "satisfied");
      },
    };
    const turn = h.makeTurn({ rounds: [skipOnce, after] });

    const result = await turn.runAsync();

    // iteration 1: skip fired next-iteration so "after" never ran; iteration 2 reached it
    expect(log).toEqual(["skip#0", "skip#1", "after@2"]);
    expect(result.iterations).toBe(2);
  });

  test("no round ending the turn runs to the cap and returns capped with the truncation notice", async () => {
    const h = makeHarness();
    const log: string[] = [];
    const turn = h.makeTurn({ maxIterations: 3, rounds: [stub(["continue"], log, "r")] });

    const result = await turn.runAsync();

    expect(result).toMatchObject({ outcome: "capped", iterations: 3 });
    expect(h.conversation.messages.at(-1)!.content).toContain("hit iteration cap of 3");
    expect(eventTypes(h)).toContain(OrchestratorEventTypes.WARNING);
  });

  test("an aborted signal stops the loop before any round runs", async () => {
    const controller = new AbortController();
    controller.abort();
    const h = makeHarness({ signal: controller.signal });
    const log: string[] = [];
    const turn = h.makeTurn({ rounds: [stub(["continue"], log, "r")] });

    await expect(turn.runAsync()).rejects.toThrow("turn aborted");
    expect(log).toEqual([]);
  });
});
