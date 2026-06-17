import { describe, expect, test } from "@jest/globals";

import { SessionManager } from "../../src/agent/session/session-manager.js";
import type { ChildRuntime, SubRuntimeRefs } from "../../src/agent/runners/subsession.js";
import type { RunResult } from "../../src/agent/runners/orchestrator.js";
import { newUsageTotals, type Session } from "../../src/agent/session/session.js";
import type { Workspace } from "../../src/agent/registries/workspace-registry.js";

// Each sub-session's run signal derives from the manager's parent signal (the runtime scope), so an ancestor
// abort reaches every child without the manager being enumerated, while finalize() keeps cutting exactly one.

const workspace = { workspaceId: "ws" } as Workspace;

// fake child runtime: dispatchAsync parks until its signal aborts (then rejects, like a real provider call)
// or the test releases it via `finish`
function makeFakeChildFactory() {
  const releases: Array<() => void> = [];
  const seenSignals: Array<AbortSignal | undefined> = [];

  const factory = (refs: SubRuntimeRefs): ChildRuntime => {
    const session = {
      sessionId: refs.sessionId,
      status: "running",
      counters: { turns: 0 },
      updatedAt: Date.now(),
    } as unknown as Session;

    const runtime: ChildRuntime = {
      build: async () => runtime,
      getSession: () => session,
      metricsTotals: () => newUsageTotals(),
      dispatchAsync: (_input: string, options?: { signal?: AbortSignal }) => {
        seenSignals.push(options?.signal);
        return new Promise<RunResult>((resolve, reject) => {
          const signal = options?.signal;
          if (signal?.aborted) return reject(new Error("aborted before start"));
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          releases.push(() =>
            resolve({
              outcome: "satisfied",
              finalMessage: { role: "assistant", content: "done" },
              iterations: 1,
              dispatches: 0,
            } as unknown as RunResult)
          );
        });
      },
      injectInput: () => {},
      awaitAllSubSessions: async () => {},
      finalize: async () => {},
    };
    return runtime;
  };

  return { factory, releases, seenSignals };
}

describe("SessionManager under a parent signal", () => {
  test("parent abort settles every running child as error", async () => {
    const parent = new AbortController();
    const { factory } = makeFakeChildFactory();
    const manager = new SessionManager(factory, 2, undefined, parent.signal);

    const a = manager.createSubSession({ parentSessionId: "p", workspace, intent: "task a" });
    const b = manager.createSubSession({ parentSessionId: "p", workspace, intent: "task b" });
    expect(a.outcome).toBe("created");
    expect(b.outcome).toBe("created");

    parent.abort("runtime shutdown");
    await manager.awaitAllActive();

    const statusA = await manager.getStatus("p", a.snapshot!.subSessionId);
    const statusB = await manager.getStatus("p", b.snapshot!.subSessionId);
    expect(statusA?.snapshot.status).toBe("error");
    expect(statusB?.snapshot.status).toBe("error");
  });

  test("a child spawned after the parent aborted is stillborn", async () => {
    const parent = new AbortController();
    parent.abort();
    const { factory } = makeFakeChildFactory();
    const manager = new SessionManager(factory, 2, undefined, parent.signal);

    const result = manager.createSubSession({ parentSessionId: "p", workspace, intent: "late task" });
    expect(result.outcome).toBe("created"); // record is made…
    await manager.awaitAllActive();

    const status = await manager.getStatus("p", result.snapshot!.subSessionId);
    expect(status?.snapshot.status).toBe("error"); // …but the run never did work
  });

  test("the child runtime is built under the sub-session's derived signal", async () => {
    const parent = new AbortController();
    const { factory, seenSignals, releases } = makeFakeChildFactory();
    const manager = new SessionManager(
      ((refs: SubRuntimeRefs) => {
        // The refs carry the derived signal for the child runtime's own scope.
        expect(refs.parentSignal).toBeDefined();
        return factory(refs);
      }) as typeof factory,
      2,
      undefined,
      parent.signal
    );

    manager.createSubSession({ parentSessionId: "p", workspace, intent: "task" });
    await new Promise((r) => setImmediate(r)); // let the detached build start
    expect(seenSignals).toHaveLength(1);
    expect(seenSignals[0]?.aborted).toBe(false);

    releases.forEach((finish) => finish());
    await manager.awaitAllActive();
  });

  test("finalize cuts ONE child; siblings and the parent are untouched", async () => {
    const parent = new AbortController();
    const { factory, releases } = makeFakeChildFactory();
    const manager = new SessionManager(factory, 2, undefined, parent.signal);

    const doomed = manager.createSubSession({ parentSessionId: "p", workspace, intent: "doomed" });
    const survivor = manager.createSubSession({ parentSessionId: "p", workspace, intent: "survivor" });
    await new Promise((r) => setImmediate(r));

    manager.finalize("p", doomed.snapshot!.subSessionId, "error");

    const doomedStatus = await manager.getStatus("p", doomed.snapshot!.subSessionId);
    const survivorStatus = await manager.getStatus("p", survivor.snapshot!.subSessionId);
    expect(doomedStatus?.snapshot.status).toBe("archived");
    expect(survivorStatus?.snapshot.status).toBe("running");
    expect(parent.signal.aborted).toBe(false);

    releases.forEach((finish) => finish());
    await manager.awaitAllActive();
  });
});
