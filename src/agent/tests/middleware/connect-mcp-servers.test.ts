import { describe, expect, jest, test } from "@jest/globals";

import { ConnectMcpServersMiddleware } from "../../src/agent/runtime/middleware/connect-mcp-servers.js";
import { makeContext } from "./context.js";

/**
 * ConnectMcpServersMiddleware is currently a pass-through stub: the in-process
 * servers (fsmcp, Excel) are already registered as LocalMcps by
 * AddMcpServersMiddleware, and spawning real stdio servers from mcp.json is not
 * yet wired. Its only contract today is to continue the pipeline.
 */
describe("ConnectMcpServersMiddleware", () => {
  test("continues the pipeline without touching the registry", async () => {
    const ctx = makeContext();
    const next = jest.fn(async () => {});

    await new ConnectMcpServersMiddleware().initialize(ctx, next);

    expect(next).toHaveBeenCalledTimes(1);
  });
});
