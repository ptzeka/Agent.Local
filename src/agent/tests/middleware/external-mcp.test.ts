import { describe, expect, test } from "@jest/globals";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { readMcpServerDefs } from "../../src/agent/runtime/middleware/external-mcp.js";
import { createSession, memoryCollectionFor } from "../../src/agent/session/session.js";

describe("readMcpServerDefs", () => {
  test("returns the mcpServers map from a valid mcp.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcpcfg-"));
    const file = join(dir, "mcp.json");
    writeFileSync(
      file,
      JSON.stringify({ mcpServers: { memomcp: { command: "node", args: ["server.js"] } } }),
      "utf-8",
    );
    try {
      const defs = readMcpServerDefs(file);
      expect(defs.memomcp).toEqual({ command: "node", args: ["server.js"] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("missing or malformed file yields no servers rather than throwing", () => {
    expect(readMcpServerDefs(join(tmpdir(), "does-not-exist-mcp.json"))).toEqual({});

    const dir = mkdtempSync(join(tmpdir(), "mcpcfg-"));
    const file = join(dir, "mcp.json");
    writeFileSync(file, "{ not json", "utf-8");
    try {
      expect(readMcpServerDefs(file)).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("memoryCollectionFor", () => {
  test("anonymous session is segregated by its own session id", () => {
    const session = createSession({ sessionId: "sess-123", workspaceId: "w1", conversationId: "c1" });
    expect(session.user).toBeUndefined();
    expect(memoryCollectionFor(session)).toBe("sess-123");
  });

  test("an authenticated principal scopes memory to the subject, not the session", () => {
    const session = createSession({ sessionId: "sess-123", workspaceId: "w1", conversationId: "c1" });
    session.user = { sub: "user-42", isAuthenticated: true, claims: {}, scopes: [] };
    expect(memoryCollectionFor(session)).toBe("user-42");
  });

  test("an unauthenticated principal still falls back to the session id", () => {
    const session = createSession({ sessionId: "sess-123", workspaceId: "w1", conversationId: "c1" });
    session.user = { sub: "anonymous", isAuthenticated: false, claims: {}, scopes: [] };
    expect(memoryCollectionFor(session)).toBe("sess-123");
  });
});
