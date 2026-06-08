import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Initializer } from "../src/agent/initializer.js";
import type { McpToolClient } from "../src/agent/mcp-client.js";
import type { ModelRegistry } from "../src/agent/model-registry.js";
import { createSession } from "../src/agent/session.js";
import { SessionStore } from "../src/agent/session-store.js";
import { WorkspaceRegistry } from "../src/agent/workspace-registry.js";

/**
 * Initializer lifecycle tests.
 *
 * These exercise only the stateful session bookkeeping — open / resume / list /
 * reset and the guard paths — none of which touch an LLM. `registry` and `tools`
 * are passed as fakes because the Initializer hands them straight to the
 * (stateless) Orchestrator constructor, which only stores them; no test here
 * drives a turn, so they are never invoked. The SessionStore and
 * WorkspaceRegistry are the real implementations, pointed at a throwaway temp
 * directory so persistence is genuinely tested without polluting the repo.
 */
describe("Initializer", () => {
  // Casts stand in for the heavy collaborators: only their identity is used
  // (stored on the Orchestrator), never their behaviour, in these tests.
  const fakeRegistry = {} as unknown as ModelRegistry;
  const fakeTools = {} as unknown as McpToolClient;

  let tempDir: string;
  let store: SessionStore;
  let initializer: Initializer;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-init-test-"));
    store = SessionStore.create(path.join(tempDir, "sessions"));
    initializer = new Initializer({
      registry: fakeRegistry,
      tools: fakeTools,
      sessionStore: store,
      workspaces: new WorkspaceRegistry(),
    });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("openSession", () => {
    test("creates an idle session, tracks it in memory, and persists it", async () => {
      const session = await initializer.openSession({ workspaceRoot: tempDir });

      expect(session.status).toBe("idle");
      expect(session.counters.turns).toBe(0);
      expect(session.conversation).toHaveLength(0);

      // Tracked in memory: resolvable by id without a reload.
      expect(initializer.getSession(session.sessionId)).toBe(session);

      // Persisted from the first turn: the store can load it back.
      const reloaded = await store.load(session.sessionId);
      expect(reloaded?.sessionId).toBe(session.sessionId);
    });

    test("sessions sharing a workspaceId resolve to the same workspace", async () => {
      const first = await initializer.openSession({ workspaceRoot: tempDir });
      const second = await initializer.openSession({
        workspaceRoot: tempDir,
        workspaceId: first.workspaceId,
      });

      expect(second.workspaceId).toBe(first.workspaceId);
      // No agentcontext.md in the temp dir, so context resolves to null for both.
      expect(initializer.getWorkspaceContext(first.sessionId)).toBeNull();
      expect(initializer.getWorkspaceContext(second.sessionId)).toBeNull();
    });
  });

  describe("unknown session guards", () => {
    test("getSession throws for an unknown id", () => {
      expect(() => initializer.getSession("nope")).toThrow(/Unknown sessionId/);
    });

    test("dispatch rejects for an unknown id", async () => {
      await expect(initializer.dispatch("nope", "hi")).rejects.toThrow(/Unknown sessionId/);
    });
  });

  describe("resumeSession", () => {
    test("throws when no session is persisted under the id", async () => {
      await expect(
        initializer.resumeSession({ sessionId: "missing", workspaceRoot: tempDir })
      ).rejects.toThrow(/No persisted session/);
    });

    test("normalizes a leftover 'running' status to 'awaiting-input'", async () => {
      // Simulate a process that crashed mid-turn: a persisted session still
      // flagged 'running'. On resume it must become dispatchable again.
      const crashed = createSession({ sessionId: "crashed", workspaceId: "ws-1" });
      crashed.status = "running";
      await store.save(crashed);

      const resumed = await initializer.resumeSession({
        sessionId: "crashed",
        workspaceRoot: tempDir,
      });

      expect(resumed.status).toBe("awaiting-input");
    });
  });

  describe("listSavedSessions", () => {
    test("returns top-level sessions and omits sub-sessions", async () => {
      const top = await initializer.openSession({ workspaceRoot: tempDir });
      // A sub-session carries a parentSessionId; it is persisted but must never
      // appear in the resume picker.
      await initializer.openSession({ workspaceRoot: tempDir, parentSessionId: top.sessionId });

      const summaries = await initializer.listSavedSessions();

      expect(summaries).toHaveLength(1);
      expect(summaries[0].sessionId).toBe(top.sessionId);
    });
  });

  describe("reset", () => {
    test("clears the transcript and resets counters and status", async () => {
      const session = await initializer.openSession({ workspaceRoot: tempDir });
      // Mutate the live session as a completed turn would.
      session.conversation.push({ role: "user", content: "hello" });
      session.counters.turns = 3;
      session.status = "awaiting-input";

      const result = await initializer.reset(session.sessionId);

      expect(session.conversation).toHaveLength(0);
      expect(session.counters.turns).toBe(0);
      expect(session.status).toBe("idle");
      // No context file present, so nothing changed across the reload.
      expect(result.context).toBeNull();
      expect(result.contextChanged).toBe(false);
    });
  });

  describe("spawnBackground", () => {
    test("rejects because background agents are not implemented yet", async () => {
      await expect(initializer.spawnBackground()).rejects.toThrow(/not implemented yet/);
    });
  });
});
