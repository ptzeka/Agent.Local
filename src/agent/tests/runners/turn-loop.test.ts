import { describe, expect, jest, test } from "@jest/globals";

import { Eventing } from "@agent-local/common/eventing";
import type { Mcp } from "@agent-local/mcp";
import type { Conversation } from "../../src/agent/conversation/conversation.js";
import type { ContextSnapshot } from "../../src/agent/context/context-loader.js";
import type {
  ChatMessage,
  ChatResponse,
  LLMProvider,
  ToolCall,
} from "../../src/agent/providers/provider.js";
import type { ModelsFile, RoleDefinition } from "../../src/agent/registries/configuration-registry.js";
import type { ModelRegistry } from "../../src/agent/registries/model-registry.js";
import type { ScopedToolClient } from "../../src/agent/scoped-tool-client.js";
import type { AgentRuntimeQueryable } from "../../src/agent/runtime/types.js";
import { DispatchTracker } from "../../src/agent/synthetic-mcp/dispatch-tracker.js";
import { TurnResultCapture } from "../../src/agent/synthetic-mcp/turn-result-tools.js";
import { TURN_RESULT_SERVER_NAME } from "../../src/agent/synthetic-mcp/turn-result-server.js";
import { TurnLoop } from "../../src/agent/runners/turn-loop.js";
import { ModelCaller } from "../../src/agent/runners/model-caller.js";
import { ToolCaller } from "../../src/agent/runners/tool-caller.js";
import { Turn } from "../../src/agent/runners/turn.js";
import { runEvaluatorPass, EVALUATOR_SERVER_NAME } from "../../src/agent/runners/evaluator-pass.js";
import { validateShape } from "../../src/agent/runners/policies/dispatch-result.js";
import { resolveTurnProfile, type TurnProfile } from "../../src/agent/runners/turn-profile.js";
import {
  AcceptFirstReplyCompletion,
  ReportRequiredCompletion,
  ToolEvidenceCompletion,
  selectCompletionPolicy,
} from "../../src/agent/runners/policies/completion.js";
import { MemoryContributor } from "../../src/agent/runners/policies/memory-contributor.js";
import { SnapshotContextProvider } from "../../src/agent/runners/policies/snapshot-context-provider.js";
import { SummarizeCompaction } from "../../src/agent/runners/policies/summarize-compaction.js";
import type {
  CompletionPolicy,
  ContextContributor,
} from "../../src/agent/runners/policies/types.js";
import type { RunnerContext } from "../../src/agent/runners/middleware/runner-middleware.js";
import { OrchestratorEventTypes } from "../../src/agent/runners/runner-events.js";

// Two levels are exercised here: each policy/step in isolation against a hand-built Turn, and the
// whole TurnLoop against a faked runtime. The harness fakes only the seams the loop touches
// (conversation, providers, registries, context loader) and records every published event.

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

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
    replaceAll: jest.fn(async (...args: unknown[]) => {
      messages.length = 0;
      messages.push(...(args[0] as ChatMessage[]));
    }),
  };
}

// the provider contract mirrors toolCalls into hasToolCalls; the helper keeps every fixture honest
function chatReply(content: string, toolCalls?: ToolCall[]): ChatResponse {
  return {
    message: { role: "assistant", content, ...(toolCalls ? { toolCalls } : {}) },
    hasToolCalls: !!toolCalls?.length,
  };
}

const TOOL_CALL: ToolCall = { id: "c1", name: "t", arguments: {} };

function makeConfig(overrides: Partial<ModelsFile["orchestration"]> = {}): ModelsFile {
  return {
    models: {},
    roles: {},
    orchestration: {
      evaluatorEnabled: false,
      evaluatorTemperature: 0,
      orchestratorTemperature: 0.2,
      executorTemperature: 0.1,
      maxExecutorDispatchesPerTurn: 10,
      maxOrchestratorIterations: 16,
      maxExecutorIterationsPerAsk: 6,
      // high enough that compaction never fires unless a test lowers it
      summarizeAtMessages: 100,
      summarizerKeepLastN: 2,
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
  // mounts the turn-result server, which is what puts a role into structured mode
  turnResultMounted?: boolean;
  // the judge sub-agent's final answer (the returns JSON), and also the summarizer provider's reply
  evaluatorReply?: string;
  // the evaluator role's tool whitelist in the fake role record
  evaluatorTools?: string[];
  chatResponse?: ChatResponse;
  // one response per model call, in order — for driving a turn across iterations
  chatSequence?: ChatResponse[];
  chatError?: Error;
  signal?: AbortSignal;
  contextSnapshot?: ContextSnapshot;
  config?: ModelsFile;
}

interface TurnOverrides {
  profile?: Partial<TurnProfile>;
  tracker?: DispatchTracker;
  // installs the built context prefix directly, bypassing the context provider
  contextMessages?: ChatMessage[];
  turnRequest?: string | null;
  toolCallsMade?: number;
  iteration?: number;
}

interface Harness {
  ctx: RunnerContext;
  conversation: FakeConversation;
  events: Array<{ type: string; payload: Record<string, unknown> }>;
  chat: jest.Mock;
  callTool: jest.Mock;
  config: ModelsFile;
  inbox: string[];
  makeTurn: (overrides?: TurnOverrides) => Turn;
}

const ORCHESTRATOR_PROFILE: TurnProfile = {
  role: "orchestrator",
  maxIterations: 16,
  temperature: 0.2,
  needsTurnBinding: true,
  completion: "self-terminate",
  evaluatorPass: false,
};

function makeHarness(opts: HarnessOptions = {}): Harness {
  const conversation = makeConversation();
  const eventBus = new Eventing();
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  eventBus.subscribe((event) => events.push(event as { type: string; payload: Record<string, unknown> }));

  let chatCall = 0;
  const chat = jest.fn(async (): Promise<ChatResponse> => {
    if (opts.chatError) throw opts.chatError;
    if (opts.chatSequence) return opts.chatSequence[Math.min(chatCall++, opts.chatSequence.length - 1)]!;
    return opts.chatResponse ?? chatReply("answer");
  });
  const provider = {
    providerName: "fake",
    modelId: "fake-model",
    supportsNativeTools: true,
    chat,
  } as unknown as LLMProvider;

  const evaluatorChat = jest.fn(async (): Promise<ChatResponse> =>
    chatReply(opts.evaluatorReply ?? "EVALUATOR: SATISFIED looks done")
  );
  const evaluatorProvider = { providerName: "judge", modelId: "judge-model", chat: evaluatorChat };

  const callTool = jest.fn(async () => ({ content: "tool-ok", isError: false }));
  const scopedClients = { callTool, listTools: () => [] } as unknown as ScopedToolClient;

  const config = opts.config ?? makeConfig();
  const turnResultClient = { name: TURN_RESULT_SERVER_NAME, listTools: () => [] };
  // the evaluator dispatch client: its callTool returns the validated verdict JSON the real server would produce
  const evaluatorCallTool = jest.fn(async () => ({
    isError: false,
    content: opts.evaluatorReply ?? '{"status":"pass","reason":"ok"}',
  }));
  const evaluatorClient = { name: EVALUATOR_SERVER_NAME, listTools: () => [], callTool: evaluatorCallTool };
  const runtime = {
    getMcpClientRegistry: () => ({
      getClient: (name: string) => {
        if (name === "memomcp") return opts.memoryClient ?? null;
        if (name === TURN_RESULT_SERVER_NAME) return opts.turnResultMounted ? turnResultClient : null;
        if (name === EVALUATOR_SERVER_NAME) return evaluatorClient;
        return null;
      },
      listClients: () => [],
    }),
    getModelsRegistry: () => ({
      getAnchorText: (request: string) => `ANCHOR: ${request}`,
      // the auxiliary models resolve through the same seam, so the role decides which fake answers
      getProviderForRole: (role: string) =>
        role === "evaluator" || role === "summarizer" ? "judge-model" : "main-model",
      getIterationCapForModel: () => undefined,
      // a tooled evaluator triggers the sub-agent path; every other role stays tool-free here
      getValidMcpServersForRole: (role: string) =>
        role === "evaluator" ? opts.evaluatorTools ?? [] : [],
      // the record a real models.json would carry; caps/temps derive from config so tests can drive them
      getRoleDefinition: (role: string) => {
        if (role === "evaluator") {
          return {
            model: "judge-model",
            prompt: "evaluator",
            completion: "self-terminate",
            dispatchable: true,
            tools: opts.evaluatorTools,
            dispatch: {
              description: "verify",
              returns: {
                required: ["status", "reason"],
                properties: {
                  status: { enum: ["pass", "fail", "incomplete"], default: "pass" },
                  reason: { default: "evaluator returned no parseable verdict; defaulting to pass" },
                },
                report: "EVALUATOR: {status:upper} — {reason}",
              },
            },
          };
        }
        const isExec = role === "executor";
        return {
          model: "main-model",
          prompt: role,
          // a mounted turn-result server means this role's contract is structured-verdict (mirrors real config)
          completion: isExec
            ? "tool-evidence"
            : opts.turnResultMounted
              ? "structured-verdict"
              : "self-terminate",
          maxIterations: isExec
            ? config.orchestration.maxExecutorIterationsPerAsk ?? 6
            : config.orchestration.maxOrchestratorIterations ?? 16,
          temperature: isExec
            ? config.orchestration.executorTemperature
            : config.orchestration.orchestratorTemperature,
          dispatchable: isExec,
        };
      },
    }),
    getProvidersRegistry: () => ({
      getProvider: (name: string) => (name === "judge-model" ? evaluatorProvider : provider),
    }),
    getConfigurationRegistry: () => ({ getModelsConfiguration: async () => config }),
    getContextLoader: () => ({
      getContextSnapshot: async () => opts.contextSnapshot ?? { systemPrompt: "", projectContext: "" },
    }),
    getConversation: () => conversation,
    getEvents: () => eventBus,
    isStreamOutputEnabled: () => false,
    getSession: () => ({ contextHashes: { summarizer: "h" } }),
  } as unknown as AgentRuntimeQueryable;

  const inbox = [...(opts.inbox ?? [])];
  const ctx: RunnerContext = {
    // contextHashes present for every role so the context provider resolves a snapshot
    session: { sessionId: "s1", contextHashes: { orchestrator: "h", executor: "h" } },
    events: eventBus,
    signal: opts.signal ?? new AbortController().signal,
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    registry: {},
    runtime,
    hasPending: () => inbox.length > 0,
    // FIFO to mirror the real InputInbox.dequeue
    pullInjectedPrompt: () => inbox.shift() ?? "",
  } as unknown as RunnerContext;

  const makeTurn = (overrides: TurnOverrides = {}): Turn => {
    const turn = new Turn(ctx, {
      profile: { ...ORCHESTRATOR_PROFILE, ...overrides.profile },
      provider,
      scopedClients,
      visibleTools: [],
      tracker: overrides.tracker ?? new DispatchTracker(10, 0),
      resultSink: new TurnResultCapture(),
      conversation: conversation as unknown as Conversation,
      config,
      streaming: false,
    });
    turn.turnRequest = overrides.turnRequest ?? null;
    turn.toolCallsMade = overrides.toolCallsMade ?? 0;
    turn.iteration = overrides.iteration ?? 1;
    if (overrides.contextMessages) turn.setContextMessages(overrides.contextMessages);
    return turn;
  };

  return { ctx, conversation, events, chat, callTool, config, inbox, makeTurn };
}

function eventTypes(h: Harness): string[] {
  return h.events.map((event) => event.type);
}

// ---------------------------------------------------------------------------
// TurnProfile — the one place a role name is tested
// ---------------------------------------------------------------------------

describe("resolveTurnProfile", () => {
  // a fake registry serving one role record, so the test drives the profile purely from data
  const registryFor = (def: Partial<RoleDefinition>, modelCap?: number): ModelRegistry =>
    ({
      getRoleDefinition: () => ({ model: "m", prompt: "p", completion: "self-terminate", ...def }),
      getIterationCapForModel: () => modelCap,
    }) as unknown as ModelRegistry;

  test("a coordinator role binds, runs the evaluator pass, and takes its declared cap/temp/completion", () => {
    const profile = resolveTurnProfile({
      role: "orchestrator",
      config: makeConfig({ evaluatorEnabled: true }),
      modelsRegistry: registryFor({
        completion: "self-terminate",
        maxIterations: 16,
        temperature: 0.2,
        dispatchable: false,
      }),
    });

    expect(profile).toMatchObject({
      role: "orchestrator",
      maxIterations: 16,
      temperature: 0.2,
      needsTurnBinding: true,
      completion: "self-terminate",
      evaluatorPass: true,
    });
  });

  test("a dispatchable (leaf) role never binds and never self-evaluates", () => {
    const profile = resolveTurnProfile({
      role: "executor",
      config: makeConfig({ evaluatorEnabled: true }),
      modelsRegistry: registryFor({
        completion: "tool-evidence",
        maxIterations: 6,
        temperature: 0.1,
        dispatchable: true,
      }),
    });

    expect(profile).toMatchObject({
      maxIterations: 6,
      temperature: 0.1,
      needsTurnBinding: false,
      completion: "tool-evidence",
      evaluatorPass: false,
    });
  });

  test("a model's own iteration cap wins over the role's declared cap", () => {
    const profile = resolveTurnProfile({
      role: "orchestrator",
      config: makeConfig(),
      modelsRegistry: registryFor({ maxIterations: 16 }, 3),
    });

    expect(profile.maxIterations).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// SnapshotContextProvider
// ---------------------------------------------------------------------------

describe("SnapshotContextProvider", () => {
  test("builds the standing-direction + system prefix from the role's snapshot", async () => {
    const h = makeHarness({
      contextSnapshot: { projectContext: "proj direction", systemPrompt: "sys" } as ContextSnapshot,
    });
    const turn = h.makeTurn();

    const prefix = await new SnapshotContextProvider().build(turn, h.ctx);

    expect(prefix).toEqual([
      { role: "system", content: expect.stringContaining("proj direction") },
      { role: "system", content: "sys" },
    ]);
  });

  test("seeding the prefix places it ahead of the live conversation", async () => {
    const h = makeHarness({ contextSnapshot: { projectContext: "", systemPrompt: "sys" } as ContextSnapshot });
    h.conversation.messages.push({ role: "user", content: "prior" });
    const turn = h.makeTurn();

    turn.setContextMessages(await new SnapshotContextProvider().build(turn, h.ctx));

    expect(turn.workingMessages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "prior" },
    ]);
  });

  test("an unstamped session is a hard error — the snapshot is the only source of the prompt", async () => {
    const h = makeHarness();
    (h.ctx.session as { contextHashes: Record<string, string> }).contextHashes = {};
    const turn = h.makeTurn();

    await expect(new SnapshotContextProvider().build(turn, h.ctx)).rejects.toThrow(
      "no context snapshot"
    );
  });
});

// ---------------------------------------------------------------------------
// SummarizeCompaction
// ---------------------------------------------------------------------------

describe("SummarizeCompaction", () => {
  test("under the threshold it no-ops: history untouched, no summarizer call, no events", async () => {
    const h = makeHarness();
    const turn = h.makeTurn({ turnRequest: "the ask" });

    await new SummarizeCompaction().applyIfNeeded(turn, h.ctx);

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

    await new SummarizeCompaction().applyIfNeeded(turn, h.ctx);

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
// MemoryContributor
// ---------------------------------------------------------------------------

describe("MemoryContributor", () => {
  test("injects recalled memories as a transient system message — working set only, never the transcript", async () => {
    const memoryClient = { callTool: jest.fn(async () => ({ content: "remembered facts", isError: false })) };
    const h = makeHarness({ memoryClient });
    const turn = h.makeTurn({ turnRequest: "the ask" });

    await new MemoryContributor().contribute(turn, h.ctx);

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

  test("no-ops when memomcp is not mounted (executor role / no collection)", async () => {
    const h = makeHarness({ memoryClient: null });
    const turn = h.makeTurn({ turnRequest: "the ask" });

    await new MemoryContributor().contribute(turn, h.ctx);

    expect(turn.workingMessages).toHaveLength(0);
    expect(h.events).toHaveLength(0);
  });

  test("fails open: a recall error warns and returns instead of blocking the turn", async () => {
    const memoryClient = {
      callTool: jest.fn(async () => {
        throw new Error("store offline");
      }),
    };
    const h = makeHarness({ memoryClient });
    const turn = h.makeTurn({ turnRequest: "the ask" });

    await new MemoryContributor().contribute(turn, h.ctx);

    expect(turn.workingMessages).toHaveLength(0);
    expect(eventTypes(h)).toEqual([
      OrchestratorEventTypes.RECALL_START,
      OrchestratorEventTypes.WARNING,
    ]);
  });
});

// ---------------------------------------------------------------------------
// ModelCaller
// ---------------------------------------------------------------------------

describe("ModelCaller", () => {
  test("anchors the request last, appends the reply everywhere, and returns it as data", async () => {
    const response: ChatResponse = { ...chatReply("the answer"), usage: { inputTokens: 1 } };
    const h = makeHarness({ chatResponse: response });
    const turn = h.makeTurn({
      turnRequest: "the ask",
      contextMessages: [{ role: "user", content: "the ask" }],
    });

    const reply = await new ModelCaller().call(turn, h.ctx);

    const sentMessages = h.chat.mock.calls[0]![0] as ChatMessage[];
    expect(sentMessages.at(-1)).toEqual({ role: "system", content: "ANCHOR: the ask" });
    expect(reply.assistantMessage).toMatchObject({ role: "assistant", content: "the answer" });
    expect(reply.toolCalls).toEqual([]);
    expect(h.conversation.messages.at(-1)).toBe(reply.assistantMessage);
    expect(turn.workingMessages.at(-1)).toBe(reply.assistantMessage);
    // ITERATION is published by the orchestrator loop, not the model call
    expect(eventTypes(h)).toEqual([OrchestratorEventTypes.MESSAGE]);
    // usage is stamped with the session so the spend stays attributable downstream
    expect((response.usage as never as { sessionId?: string }).sessionId).toBe("s1");
  });

  test("the profile's temperature drives the call, not a role branch at the call site", async () => {
    const h = makeHarness();
    const turn = h.makeTurn({ turnRequest: "the ask", profile: { temperature: 0.7 } });

    await new ModelCaller().call(turn, h.ctx);

    expect((h.chat.mock.calls[0]![1] as { temperature: number }).temperature).toBe(0.7);
  });

  test("native tool calls come back on the reply for the loop to act on", async () => {
    const calls = [{ id: "c1", name: "fs_read", arguments: { path: "a" } }];
    const h = makeHarness({
      chatResponse: chatReply("", calls),
    });
    const turn = h.makeTurn({ turnRequest: "the ask" });

    const reply = await new ModelCaller().call(turn, h.ctx);

    expect(reply.toolCalls).toEqual(calls);
  });

  test("a provider failure surfaces as a thrown error naming provider, model, and iteration", async () => {
    const h = makeHarness({ chatError: new Error("rate limited") });
    const turn = h.makeTurn({ turnRequest: "the ask", iteration: 4 });

    await expect(new ModelCaller().call(turn, h.ctx)).rejects.toThrow(
      "Orchestrator (fake:fake-model) failed at iteration 4: rate limited"
    );
  });
});

// ---------------------------------------------------------------------------
// ToolCaller
// ---------------------------------------------------------------------------

describe("ToolCaller", () => {
  const calls = [
    { id: "c1", name: "fs_read", arguments: { path: "a" } },
    { id: "c2", name: "fs_write", arguments: { path: "b" } },
  ];

  test("executes every call, appends paired tool messages, counts evidence, and flushes", async () => {
    const h = makeHarness();
    const turn = h.makeTurn({ turnRequest: "the ask" });

    const reported = await new ToolCaller().run(turn, h.ctx, calls);

    expect(reported).toBeNull();
    expect(h.callTool).toHaveBeenCalledTimes(2);
    expect(turn.toolCallsMade).toBe(2);
    expect(h.conversation.messages).toEqual(turn.workingMessages);
    expect(h.conversation.messages.map((message) => message.toolCallId)).toEqual(["c1", "c2"]);
    expect(h.conversation.flush).toHaveBeenCalledTimes(1);
  });

  test("a failing tool result is wrapped as [tool-error] instead of aborting the turn", async () => {
    const h = makeHarness();
    h.callTool.mockResolvedValueOnce({ content: "boom", isError: true } as never);
    const turn = h.makeTurn({ turnRequest: "the ask" });

    await new ToolCaller().run(turn, h.ctx, [calls[0]!]);

    expect(h.conversation.messages[0]!.content).toBe("[tool-error] boom");
  });

  test("a landed report_result is returned for the loop to finalize, not acted on here", async () => {
    const h = makeHarness();
    const turn = h.makeTurn({ turnRequest: "the ask" });
    turn.resultSink.set({ status: "fail", result: { reason: "could not" } } as never);

    const reported = await new ToolCaller().run(turn, h.ctx, [calls[0]!]);

    expect(reported).toMatchObject({ status: "fail" });
    // the reporting path flushes with its envelope instead, so this one must not double-flush
    expect(h.conversation.flush).not.toHaveBeenCalled();
  });

  test("an aborted signal stops before any tool runs", async () => {
    const controller = new AbortController();
    controller.abort();
    const h = makeHarness({ signal: controller.signal });
    const turn = h.makeTurn({ turnRequest: "the ask" });

    await expect(new ToolCaller().run(turn, h.ctx, calls)).rejects.toThrow("turn aborted");
    expect(h.callTool).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Completion policies — the ONLY deciders of termination
// ---------------------------------------------------------------------------

describe("selectCompletionPolicy", () => {
  const profileOf = (overrides: Partial<TurnProfile>): TurnProfile => ({
    ...ORCHESTRATOR_PROFILE,
    ...overrides,
  });

  test("maps each completion contract name to its policy", () => {
    expect(selectCompletionPolicy(profileOf({ completion: "tool-evidence" }))).toBeInstanceOf(
      ToolEvidenceCompletion
    );
    expect(selectCompletionPolicy(profileOf({ completion: "structured-verdict" }))).toBeInstanceOf(
      ReportRequiredCompletion
    );
    // the evaluator is no longer a completion gate — a plain orchestrator turn settles on its own word
    expect(selectCompletionPolicy(profileOf({ completion: "self-terminate" }))).toBeInstanceOf(
      AcceptFirstReplyCompletion
    );
  });
});

describe("ToolEvidenceCompletion", () => {
  const reply: ChatMessage = { role: "assistant", content: "done it" };

  test("an executor that never called a tool fails — prose alone must not bank as success", async () => {
    const h = makeHarness();
    const turn = h.makeTurn({ turnRequest: "the ask", toolCallsMade: 0 });

    const verdict = await new ToolEvidenceCompletion().judge(turn, reply, h.ctx);

    expect(verdict).toMatchObject({ kind: "fail" });
    expect((verdict as { reason: string }).reason).toContain("no tool call");
  });

  test("with tool evidence the first tool-free reply settles satisfied — no judge round-trip", async () => {
    const h = makeHarness();
    const turn = h.makeTurn({ turnRequest: "the ask", toolCallsMade: 2 });

    const verdict = await new ToolEvidenceCompletion().judge(turn, reply, h.ctx);

    expect(verdict).toEqual({ kind: "settle", outcome: "satisfied" });
    expect(h.events).toHaveLength(0);
  });
});

describe("ReportRequiredCompletion", () => {
  test("never settles: it nudges for the mandated report_result, quoting the request verbatim", async () => {
    const h = makeHarness();
    const turn = h.makeTurn({ turnRequest: "the ask" });

    const verdict = await new ReportRequiredCompletion().judge(
      turn,
      { role: "assistant", content: "done" },
      h.ctx
    );

    expect(verdict.kind).toBe("continue");
    expect((verdict as { nudge: string }).nudge).toContain("report_result");
    expect((verdict as { nudge: string }).nudge).toContain("«the ask»");
  });
});

describe("AcceptFirstReplyCompletion", () => {
  test("settles satisfied without consulting a judge", async () => {
    const h = makeHarness();
    const turn = h.makeTurn({ turnRequest: "the ask" });

    const verdict = await new AcceptFirstReplyCompletion().judge(
      turn,
      { role: "assistant", content: "done" },
      h.ctx
    );

    expect(verdict).toEqual({ kind: "settle", outcome: "satisfied" });
    expect(h.events).toHaveLength(0);
  });
});

describe("runEvaluatorPass (terminal pass)", () => {
  const params = {
    question: "the ask",
    proposedAnswer: "done it",
    transcript: [{ role: "assistant", content: "done it" }] as ChatMessage[],
  };
  const signal = new AbortController().signal;
  // the judge is a dispatch MCP client whose callTool returns the validated verdict JSON (the server's output)
  const judgeReturning = (content: string) => {
    const callTool = jest.fn(async () => ({ isError: false, content }));
    return { client: { name: EVALUATOR_SERVER_NAME, listTools: () => [], callTool } as unknown as Mcp, callTool };
  };

  test("a PASS verdict stamps the conversation and reports pass", async () => {
    const h = makeHarness();

    const verdict = await runEvaluatorPass(
      h.ctx.runtime,
      judgeReturning('{"status":"pass","reason":"all good"}').client,
      params,
      signal
    );

    expect(verdict).toEqual({ state: "pass", reason: "all good" });
    expect(h.conversation.messages.at(-1)).toEqual({
      role: "system",
      content: "EVALUATOR: PASS — all good",
    });
    expect(eventTypes(h)).toEqual([
      OrchestratorEventTypes.EVALUATION_START,
      OrchestratorEventTypes.EVALUATION_VERDICT,
    ]);
  });

  test("an INCOMPLETE verdict is reported and stamped", async () => {
    const h = makeHarness();

    const verdict = await runEvaluatorPass(
      h.ctx.runtime,
      judgeReturning('{"status":"incomplete","reason":"still missing the file"}').client,
      params,
      signal
    );

    expect(verdict).toMatchObject({ state: "incomplete", reason: "still missing the file" });
    expect(h.conversation.messages.at(-1)!.content).toBe("EVALUATOR: INCOMPLETE — still missing the file");
  });

  test("calls the evaluate tool with the judge input built from the request", async () => {
    const h = makeHarness();
    const { client, callTool } = judgeReturning('{"status":"fail","reason":"cannot be done"}');

    const verdict = await runEvaluatorPass(h.ctx.runtime, client, params, signal);

    expect(callTool).toHaveBeenCalledWith("evaluate", { ask: expect.stringContaining("the ask") }, signal);
    expect(verdict).toMatchObject({ state: "fail", reason: "cannot be done" });
  });

  test("an unparseable answer fails open to the declared default — a flaky judge never traps the caller", async () => {
    const h = makeHarness();

    const verdict = await runEvaluatorPass(
      h.ctx.runtime,
      judgeReturning('{"status":"pass","reason":"evaluator returned no parseable verdict; defaulting to pass"}').client,
      params,
      signal
    );

    expect(verdict.state).toBe("pass");
    expect(h.conversation.messages.at(-1)!.content).toContain("EVALUATOR: PASS — evaluator returned no parseable");
  });

  test("a thrown dispatch fails open to pass without trapping the turn", async () => {
    const h = makeHarness();
    const callTool = jest.fn(async () => {
      throw new Error("child died");
    });
    const client = { name: EVALUATOR_SERVER_NAME, listTools: () => [], callTool } as unknown as Mcp;

    const verdict = await runEvaluatorPass(h.ctx.runtime, client, params, signal);

    expect(verdict.state).toBe("pass");
    expect(eventTypes(h)).toContain(OrchestratorEventTypes.WARNING);
  });
});

describe("validateShape", () => {
  const schema = {
    required: ["status", "reason"],
    properties: { status: { enum: ["pass", "fail", "incomplete"] } },
  };

  test("a well-formed value has no violations", () => {
    expect(validateShape({ status: "pass", reason: "ok" }, schema)).toEqual([]);
  });

  test("flags a missing required field and an out-of-enum value", () => {
    const violations = validateShape({ status: "maybe" }, schema);
    expect(violations.some((m) => m.includes("reason"))).toBe(true);
    expect(violations.some((m) => m.includes("status"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TurnLoop — the loop end to end
// ---------------------------------------------------------------------------

describe("TurnLoop.run", () => {
  test("a cold wake with nothing queued settles before a Turn is even assembled", async () => {
    const h = makeHarness({ inbox: [] });

    const result = await new TurnLoop("orchestrator").run(h.ctx);

    expect(result).toMatchObject({ outcome: "satisfied", iterations: 0, dispatches: 0 });
    expect(h.chat).not.toHaveBeenCalled();
    expect(h.conversation.messages).toHaveLength(0);
    // silent by design: no tools mounted, no servers bound, so START would announce a turn that never ran
    expect(h.events).toHaveLength(0);
  });

  test("one prompt drives the whole turn: a tool iteration then an answer, request intact throughout", async () => {
    const h = makeHarness({
      inbox: ["do X", "and this too"],
      chatSequence: [
        chatReply("", [{ id: "c1", name: "fs_read", arguments: {} }]),
        chatReply("final answer"),
      ],
    });

    const result = await new TurnLoop("orchestrator").run(h.ctx);

    expect(result).toMatchObject({
      outcome: "satisfied",
      iterations: 2,
      finalMessage: { content: "final answer" },
    });
    expect(h.chat).toHaveBeenCalledTimes(2);
    // one prompt per turn: the second stays queued for the pump to replay
    expect(h.inbox).toEqual(["and this too"]);
    expect(h.conversation.messages[0]).toEqual({ role: "user", content: "do X" });
    // the request anchors every model call, including the one after the tool round
    const secondCall = h.chat.mock.calls[1]![0] as ChatMessage[];
    expect(secondCall.at(-1)).toEqual({ role: "system", content: "ANCHOR: do X" });
  });

  test("the prologue runs exactly once across iterations", async () => {
    const memoryClient = { callTool: jest.fn(async () => ({ content: "mem", isError: false })) };
    const h = makeHarness({
      inbox: ["do X"],
      memoryClient,
      chatSequence: [chatReply("", [TOOL_CALL]), chatReply("final")],
    });

    await new TurnLoop("orchestrator").run(h.ctx);

    expect(memoryClient.callTool).toHaveBeenCalledTimes(1);
    expect(eventTypes(h).filter((type) => type === OrchestratorEventTypes.INJECTED_INPUT)).toHaveLength(1);
    expect(eventTypes(h).filter((type) => type === OrchestratorEventTypes.ITERATION)).toHaveLength(2);
  });

  test("a landed report_result ends the turn with the envelope, a fail verdict failing closed", async () => {
    const h = makeHarness({
      inbox: ["do X"],
      chatSequence: [chatReply("", [TOOL_CALL])],
    });
    // the sink is filled the way a bound turn-result server would fill it, mid tool round
    h.callTool.mockImplementationOnce(async () => ({ content: "ok", isError: false }));
    const turnLoop = new TurnLoop("orchestrator", {
      contributors: [
        {
          name: "report-injector",
          contribute: async (turn) => {
            turn.resultSink.set({ status: "fail", result: { reason: "could not" } } as never);
          },
        } as ContextContributor,
      ],
    });

    const result = await turnLoop.run(h.ctx);

    expect(result).toMatchObject({ outcome: "failed", reported: { status: "fail" } });
    const envelope = JSON.parse(h.conversation.messages.at(-1)!.content);
    expect(envelope).toMatchObject({ status: "fail", input: "do X" });
  });

  test("hitting the iteration cap returns capped with the truncation notice on record", async () => {
    const config = makeConfig({ maxOrchestratorIterations: 2 });
    const h = makeHarness({
      inbox: ["do X"],
      config,
      // always a tool call, so the loop can never reach a completion verdict
      chatResponse: chatReply("", [TOOL_CALL]),
    });

    const result = await new TurnLoop("orchestrator").run(h.ctx);

    expect(result).toMatchObject({ outcome: "capped", iterations: 2 });
    expect(h.conversation.messages.at(-1)!.content).toContain("hit iteration cap of 2");
    expect(h.events.some((event) => event.type === OrchestratorEventTypes.WARNING)).toBe(true);
  });

  test("the evaluator pass runs after the turn settles, stamping the result and transcript", async () => {
    const h = makeHarness({
      inbox: ["do the thing"],
      chatResponse: chatReply("all done"),
      evaluatorReply: '{"status":"pass","reason":"looks complete"}',
      config: makeConfig({ evaluatorEnabled: true }),
    });

    const result = await new TurnLoop("orchestrator").run(h.ctx);

    expect(result.outcome).toBe("satisfied");
    expect(result.evaluation).toEqual({ status: "pass", reason: "looks complete" });
    expect(h.conversation.messages.at(-1)).toEqual({
      role: "system",
      content: "EVALUATOR: PASS — looks complete",
    });
  });

  test("an already-aborted signal stops the loop before the first model call", async () => {
    const controller = new AbortController();
    controller.abort();
    const h = makeHarness({ inbox: ["do X"], signal: controller.signal });

    await expect(new TurnLoop("orchestrator").run(h.ctx)).rejects.toThrow("turn aborted");
    expect(h.chat).not.toHaveBeenCalled();
  });

  test("the executor profile settles on its first tool-free reply once a tool has run", async () => {
    const h = makeHarness({
      inbox: ["do X"],
      chatSequence: [chatReply("", [TOOL_CALL]), chatReply("changed the file")],
    });

    const result = await new TurnLoop("executor").run(h.ctx);

    expect(result).toMatchObject({ outcome: "satisfied", iterations: 2 });
  });

  test("an executor that only narrated fails the dispatch instead of banking a no-op", async () => {
    const h = makeHarness({
      inbox: ["do X"],
      chatResponse: chatReply("I would edit the file"),
    });

    const result = await new TurnLoop("executor").run(h.ctx);

    expect(result).toMatchObject({ outcome: "failed", iterations: 1 });
    expect(h.conversation.messages.at(-1)!.content).toContain("SYSTEM-FAILURE");
  });

  test("structured mode never settles on prose: it nudges for report_result until the cap", async () => {
    const config = makeConfig({ maxOrchestratorIterations: 2 });
    const h = makeHarness({
      inbox: ["do X"],
      config,
      turnResultMounted: true,
      chatResponse: chatReply("all done, trust me"),
    });

    const result = await new TurnLoop("orchestrator").run(h.ctx);

    // fails closed: no parseable verdict ever landed, so the turn caps rather than reporting success
    expect(result.outcome).toBe("capped");
    expect(
      h.conversation.messages.filter((message) => message.content.includes("report_result"))
    ).toHaveLength(2);
  });

  // ---------------------------------------------------------------------------
  // Extension slots
  // ---------------------------------------------------------------------------

  test("a registered contributor adds context without any power to end the turn", async () => {
    const h = makeHarness({ inbox: ["do X"] });
    const contributor: ContextContributor = {
      name: "extra",
      contribute: async (turn) => turn.injectTransient({ role: "system", content: "EXTRA CONTEXT" }),
    };

    await new TurnLoop("orchestrator", { contributors: [contributor] }).run(h.ctx);

    const sent = h.chat.mock.calls[0]![0] as ChatMessage[];
    expect(sent.some((message) => message.content === "EXTRA CONTEXT")).toBe(true);
    // additive only — nothing the contributor injected reaches the persisted transcript
    expect(h.conversation.messages.some((message) => message.content === "EXTRA CONTEXT")).toBe(false);
  });

  test("a completion override replaces the profile's own gate", async () => {
    const h = makeHarness({ inbox: ["do X"] });
    const completion: CompletionPolicy = {
      judge: async () => ({ kind: "settle", outcome: "awaiting-input" }),
    };

    const result = await new TurnLoop("orchestrator", { completion }).run(h.ctx);

    expect(result.outcome).toBe("awaiting-input");
  });

  test("a custom context provider replaces the snapshot prefix wholesale", async () => {
    const h = makeHarness({ inbox: ["do X"] });
    const contextProvider = {
      build: async () => [{ role: "system" as const, content: "REPLACED PREFIX" }],
    };

    await new TurnLoop("orchestrator", { contextProvider }).run(h.ctx);

    const sent = h.chat.mock.calls[0]![0] as ChatMessage[];
    expect(sent[0]).toEqual({ role: "system", content: "REPLACED PREFIX" });
  });
});
