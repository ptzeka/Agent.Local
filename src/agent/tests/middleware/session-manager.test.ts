import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { InputInbox } from "../../src/agent/input-inbox.js";
import { Orchestrator } from "../../src/agent/orchestrator.js";
import { SessionManagerMiddleware } from "../../src/agent/runtime/middleware/session-manager.js";
import { SessionStore } from "../../src/agent/session-store.js";
import { makeContext } from "./context.js";

/**
 * SessionManagerMiddleware business logic: compose the orchestrator, inbox, and
 * store built by earlier steps into the sub-session manager — and refuse to
 * build a half-wired manager if any collaborator is missing.
 */
describe("SessionManagerMiddleware", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "sessmgr-mw-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  test("seeds ctx.sessionManager when orchestrator, inbox, and store are present", async () => {
    const ctx = makeContext({
      orchestrator: new Orchestrator(
        {} as never,
        {} as never
      ),
      inbox: new InputInbox(),
      store: SessionStore.create(path.join(dir, "sessions")),
    });
    const next = jest.fn(async () => {});

    await new SessionManagerMiddleware().initialize(ctx, next);

    expect(ctx.sessionManager).toBeDefined();
    expect(next).toHaveBeenCalledTimes(1);
  });

  test("throws (and names every gap) when a collaborator step is missing", async () => {
    // Only the inbox is wired — orchestrator and store were never built.
    const ctx = makeContext({ inbox: new InputInbox() });
    const next = jest.fn(async () => {});

    await expect(
      new SessionManagerMiddleware().initialize(ctx, next)
    ).rejects.toThrow(/orchestrator.*store/s);
    expect(next).not.toHaveBeenCalled();
  });
});
