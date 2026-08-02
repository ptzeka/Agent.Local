import { describe, expect, jest, test } from "@jest/globals";

import { InputInbox, type ExecutedTurn } from "../../src/agent/runners/input-inbox.js";

const SETTLED: ExecutedTurn = {
  turnId: "t1",
  outcome: "satisfied",
  finalContent: "already answered",
  finishedAt: Date.now(),
};

describe("InputInbox queueing", () => {
  test("one prompt per turn, FIFO, with the fingerprint riding along", () => {
    const inbox = new InputInbox();
    inbox.push("s1", "first");
    inbox.push("s1", "second");

    expect(inbox.dequeue("s1")?.content).toBe("first");
    expect(inbox.dequeue("s1")?.content).toBe("second");
    expect(inbox.dequeue("s1")).toBeNull();
  });

  test("blank input is not a request", () => {
    const inbox = new InputInbox();
    expect(inbox.push("s1", "   \n ")).toBe(false);
    expect(inbox.hasPending("s1")).toBe(false);
  });

  test("sessions never collide: the same text in two sessions is two distinct requests", () => {
    const inbox = new InputInbox();
    inbox.push("s1", "same");
    inbox.push("s2", "same");

    expect(inbox.dequeue("s1")!.fingerprint).not.toBe(inbox.dequeue("s2")!.fingerprint);
  });
});

describe("InputInbox pending-duplicate dropping", () => {
  test("N identical child reports collapse into ONE follow-up turn", () => {
    const inbox = new InputInbox();
    const wake = jest.fn();
    inbox.setOnPush(wake);

    expect(inbox.push("s1", "child A finished", "api")).toBe(true);
    expect(inbox.push("s1", "child A finished", "api")).toBe(false);
    expect(inbox.push("s1", "child A finished", "api")).toBe(false);

    expect(inbox.dequeue("s1")?.content).toBe("child A finished");
    expect(inbox.dequeue("s1")).toBeNull();
    // an absorbed push must not wake the pump either, or it would run an empty turn
    expect(wake).toHaveBeenCalledTimes(1);
  });

  test("whitespace-only differences are the same request", () => {
    const inbox = new InputInbox();
    inbox.push("s1", "child   A\nfinished", "api");
    expect(inbox.push("s1", "child A finished", "api")).toBe(false);
  });

  test("a human retyping the same thing always gets a fresh turn", () => {
    const inbox = new InputInbox();
    expect(inbox.push("s1", "continue", "user")).toBe(true);
    expect(inbox.push("s1", "continue", "user")).toBe(true);
    expect(inbox.push("s1", "continue", "user")).toBe(true);

    expect(inbox.dequeue("s1")).not.toBeNull();
    expect(inbox.dequeue("s1")).not.toBeNull();
    expect(inbox.dequeue("s1")).not.toBeNull();
  });

  test("different content is never collapsed", () => {
    const inbox = new InputInbox();
    inbox.push("s1", "child A finished", "api");
    expect(inbox.push("s1", "child B finished", "api")).toBe(true);
  });
});

describe("InputInbox executed ledger", () => {
  test("a replayed request answers from the record", () => {
    const inbox = new InputInbox({ ttlMs: 60_000 });
    inbox.push("s1", "do the thing", "api");
    const item = inbox.dequeue("s1")!;

    expect(inbox.executedRecord("s1", item)).toBeNull();
    inbox.recordExecuted("s1", item, SETTLED);

    inbox.push("s1", "do the thing", "api");
    const replay = inbox.dequeue("s1")!;
    expect(inbox.executedRecord("s1", replay)?.finalContent).toBe("already answered");
  });

  test("human input is never replayed, even with the ledger on", () => {
    const inbox = new InputInbox({ ttlMs: 60_000 });
    inbox.push("s1", "continue", "user");
    const item = inbox.dequeue("s1")!;
    inbox.recordExecuted("s1", item, SETTLED);

    expect(inbox.executedRecord("s1", item)).toBeNull();
  });

  test("ttl 0 disables the ledger — duplicate DROPPING still works", () => {
    const inbox = new InputInbox({ ttlMs: 0 });
    inbox.push("s1", "report", "api");
    const item = inbox.dequeue("s1")!;
    inbox.recordExecuted("s1", item, SETTLED);

    expect(inbox.executedRecord("s1", item)).toBeNull();
  });

  test("a record past its ttl is forgotten", () => {
    const inbox = new InputInbox({ ttlMs: 10 });
    inbox.push("s1", "report", "api");
    const item = inbox.dequeue("s1")!;
    inbox.recordExecuted("s1", item, { ...SETTLED, finishedAt: Date.now() - 1000 });

    expect(inbox.executedRecord("s1", item)).toBeNull();
  });

  test("an explicit idempotency key identifies the request instead of its content", () => {
    const inbox = new InputInbox({ ttlMs: 60_000 });
    inbox.push("s1", "first wording", "api", "key-1");
    const first = inbox.dequeue("s1")!;
    inbox.recordExecuted("s1", first, SETTLED);

    // a caller retrying the same POST with reworded content still resolves to the same request
    inbox.push("s1", "totally different wording", "api", "key-1");
    const retry = inbox.dequeue("s1")!;
    expect(inbox.executedRecord("s1", retry)?.turnId).toBe("t1");
  });
});

describe("InputInbox clear", () => {
  test("a hard stop drops queued prompts so they don't auto-run after a cancel", () => {
    const inbox = new InputInbox();
    inbox.push("s1", "one");
    inbox.push("s1", "two");
    inbox.clear("s1");

    expect(inbox.hasPending("s1")).toBe(false);
  });
});
