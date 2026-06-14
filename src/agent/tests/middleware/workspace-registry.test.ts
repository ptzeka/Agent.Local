import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { WorkspaceRegistryMiddleware } from "../../src/agent/runtime/middleware/workspace-registry.js";
import { WorkspacesToken } from "../../src/agent/runtime/tokens.js";
import { makeContext } from "./context.js";

// stands up a fresh workspace registry for SessionMiddleware to register/resolve against
describe("WorkspaceRegistryMiddleware", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "wsreg-mw-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  test("seeds ctx.workspaces and advances the pipeline", async () => {
    const ctx = makeContext();
    const next = jest.fn(async () => {});

    await new WorkspaceRegistryMiddleware().initialize(ctx, next);

    expect(ctx.registry.tryGet(WorkspacesToken)).toBeDefined();
    expect(next).toHaveBeenCalledTimes(1);
  });

  test("the seeded registry resolves workspaces once registered", async () => {
    const ctx = makeContext();
    await new WorkspaceRegistryMiddleware().initialize(ctx, jest.fn(async () => {}));

    const workspaces = ctx.registry.get(WorkspacesToken);
    await workspaces.register("w1", root);

    expect(workspaces.get("w1").workspaceId).toBe("w1");
  });

  test("the seeded registry starts empty — resolving an unregistered id throws", async () => {
    const ctx = makeContext();
    await new WorkspaceRegistryMiddleware().initialize(ctx, jest.fn(async () => {}));

    expect(() => ctx.registry.get(WorkspacesToken).get("nope")).toThrow(/Unknown workspaceId/);
  });
});
