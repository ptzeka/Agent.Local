import { describe, expect, jest, test } from "@jest/globals";
import { CancellationToken } from "@agent-local/common/lifetime";
import { Eventing } from "@agent-local/common/eventing";

import {
  budgetCancelDetail,
  ceilingBreach,
  isBudgetCancel,
  totalSpend,
} from "../../src/agent/runners/policies/budget.js";
import { TurnCounterMiddleware } from "../../src/agent/runners/middleware/turn-counter-middleware.js";
import type { RunnerContext } from "../../src/agent/runners/middleware/runner-middleware.js";
import { OrchestratorEventTypes } from "../../src/agent/runners/runner-events.js";
import { newUsageTotals, type UsageTotals } from "../../src/agent/session/session.js";

function totals(overrides: Partial<UsageTotals> = {}): UsageTotals {
  return { ...newUsageTotals(), ...overrides };
}

describe("totalSpend", () => {
  test("counts delegated subtree cost, so dispatching the work cannot escape a ceiling", () => {
    expect(totalSpend(totals({ inputTokens: 10, outputTokens: 5 }))).toBe(15);
    expect(totalSpend(totals({ inputTokensTallied: 100 }))).toBe(100);
  });
});

describe("ceilingBreach", () => {
  const off = { perTurn: 0, perSession: 0 };

  test("0 means unlimited — the default config never caps a turn", () => {
    expect(ceilingBreach(1_000_000, 0, off)).toBeNull();
  });

  test("the session ceiling reads the cumulative tally, which is seeded from the store on resume", () => {
    const breach = ceilingBreach(500, 400, { perTurn: 0, perSession: 500 });
    expect(breach?.detail).toContain("session token ceiling");
  });

  test("the turn ceiling is measured from the turn's baseline, not from zero", () => {
    // 9_000 already spent in earlier turns: this turn has only spent 100, so a 500 turn cap is intact
    expect(ceilingBreach(9_100, 9_000, { perTurn: 500, perSession: 0 })).toBeNull();
    expect(ceilingBreach(9_600, 9_000, { perTurn: 500, perSession: 0 })?.detail).toContain(
      "turn token ceiling"
    );
  });
});

describe("budget cancel reason", () => {
  test("a budget cancel is distinguishable from a user stop through AbortSignal.any", () => {
    const parent = new AbortController();
    const cutoff = new CancellationToken(parent.signal);
    cutoff.cancel({ kind: "budget-exceeded", detail: "session token ceiling reached (10/10)" });

    expect(isBudgetCancel(cutoff.signal)).toBe(true);
    expect(budgetCancelDetail(cutoff.signal)).toContain("session token ceiling");
  });

  test("a user stop on the PARENT is never claimed as a budget stop", () => {
    const parent = new AbortController();
    const cutoff = new CancellationToken(parent.signal);
    parent.abort();

    expect(cutoff.cancelled).toBe(true);
    expect(isBudgetCancel(cutoff.signal)).toBe(false);
    expect(budgetCancelDetail(cutoff.signal)).toBeNull();
  });
});

describe("TurnCounterMiddleware budget enforcement", () => {
  function makeCtx(maxTokensPerSession: number, cutoff: CancellationToken) {
    const events = new Eventing();
    const tally = newUsageTotals();
    const metrics = {
      recordOwnUsage: (usage: { inputTokens?: number } | undefined) => {
        tally.inputTokens += usage?.inputTokens ?? 0;
      },
      recordDelegatedUsage: (usage: { inputTokens?: number } | undefined) => {
        tally.inputTokensTallied += usage?.inputTokens ?? 0;
      },
      totals: () => tally,
      flush: jest.fn(),
    };
    const ctx = {
      session: { sessionId: "s1" },
      events,
      signal: cutoff.signal,
      cutoff,
      logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
      registry: { get: () => metrics },
      runtime: {
        getConfigurationRegistry: () => ({
          getModelsConfiguration: async () => ({ orchestration: { maxTokensPerSession } }),
        }),
      },
    } as unknown as RunnerContext;
    return { ctx, events };
  }

  test("a breach cancels the turn's cutoff with a budget reason", async () => {
    const cutoff = new CancellationToken();
    const { ctx, events } = makeCtx(100, cutoff);
    const notices: string[] = [];
    events.subscribe((event) => {
      if (event.type === OrchestratorEventTypes.BUDGET_EXCEEDED) {
        notices.push(String(event.payload.detail));
      }
    });

    await new TurnCounterMiddleware().invoke(ctx, async () => {
      events.publish(OrchestratorEventTypes.MESSAGE, { usage: { inputTokens: 150 } });
      return { finalMessage: { role: "assistant", content: "" }, iterations: 1, dispatches: 0, outcome: "satisfied" };
    });

    expect(isBudgetCancel(cutoff.signal)).toBe(true);
    // the breach must SAY why, or the stop is indistinguishable from a user cancel on screen
    expect(notices[0]).toContain("session token ceiling");
  });

  test("delegated subtree spend counts toward the ceiling", async () => {
    const cutoff = new CancellationToken();
    const { ctx, events } = makeCtx(100, cutoff);

    await new TurnCounterMiddleware().invoke(ctx, async () => {
      events.publish(OrchestratorEventTypes.TOOL_RESULT, { usage: { inputTokens: 150 } });
      return { finalMessage: { role: "assistant", content: "" }, iterations: 1, dispatches: 1, outcome: "satisfied" };
    });

    expect(isBudgetCancel(cutoff.signal)).toBe(true);
  });

  test("under the ceiling the turn is never cancelled", async () => {
    const cutoff = new CancellationToken();
    const { ctx, events } = makeCtx(1000, cutoff);

    await new TurnCounterMiddleware().invoke(ctx, async () => {
      events.publish(OrchestratorEventTypes.MESSAGE, { usage: { inputTokens: 150 } });
      return { finalMessage: { role: "assistant", content: "" }, iterations: 1, dispatches: 0, outcome: "satisfied" };
    });

    expect(cutoff.cancelled).toBe(false);
  });
});
