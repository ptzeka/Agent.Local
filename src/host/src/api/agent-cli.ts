import { Router, type Request, type Response } from "express";
import type { ILogger } from "@agent-local/common";
import { requirePermission } from "../user/userContext.js";
import type { WorkStore } from "../work/work-store.js";
import type { AgentClient } from "../comms/sender.js";

// host BFF for the interactive agent CLI over a work item. The browser only ever talks to the host (cookie, same
// origin); the host validates work ownership and proxies to the agent under its OWN service token — so the cookie
// never reaches the agent and the agent stays a pure executor that knows only the sessionId. Every route is owner
// -gated by the cookie identity (req.userContext.userInfo.sub), like the works API.
export function createAgentCliApi(works: WorkStore, agent: AgentClient, logger: ILogger): Router {
  const router = Router();
  const owner = (req: Request): string => req.userContext.userInfo!.sub;

  // ensure the work has a kind=cli agent session, idempotently. Host owns the binding: reuse the stored session
  // when present, else mint one on the agent and persist it. PUT — it provisions the resource the caller streams.
  router.put("/api/agent/cli/:workId", requirePermission("workflow:write"), async (req: Request, res: Response) => {
    const work = await works.get(req.params.workId);
    if (!work || work.userId !== owner(req)) {
      res.status(404).json({ error: "unknown work" });
      return;
    }
    if (!work.workspaceId) {
      res.status(409).json({ error: "work has no workspace yet" });
      return;
    }
    let sessionId = await works.getCliSessionId(work.workId);
    if (!sessionId) {
      sessionId = await agent.createSession(work.workspaceId, work.workId, work.userId);
      await works.setCliSessionId(work.workId, sessionId);
    }
    res.json({ sessionId });
  });

  // open the live stream: resolve the owner's cli session and pipe the agent's SSE through to the browser. A
  // browser disconnect aborts the upstream fetch so the agent prunes the connection and drains its runtime.
  router.get("/api/agent/cli/:workId", requirePermission("workflow:read"), async (req: Request, res: Response) => {
    const work = await works.get(req.params.workId);
    if (!work || work.userId !== owner(req)) {
      res.status(404).json({ error: "unknown work" });
      return;
    }
    const sessionId = await works.getCliSessionId(work.workId);
    if (!sessionId) {
      res.status(409).json({ error: "cli session not initialized" });
      return;
    }

    const upstreamAbort = new AbortController();
    let upstream: Awaited<ReturnType<AgentClient["openSseStream"]>>;
    try {
      // the user's own access token is the OBO subject; the agent verifies it carries our user and binds the stream
      upstream = await agent.openSseStream(sessionId, req.userContext.accessToken, upstreamAbort.signal);
    } catch (err) {
      res.status(502).json({ error: `agent stream unavailable: ${String(err)}` });
      return;
    }
    if (!upstream.ok || !upstream.body) {
      res.status(502).json({ error: `agent /ssereceive -> ${upstream.status}` });
      return;
    }

    res.status(200).set({
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.flushHeaders?.();
    // browser closed the tab -> abort the upstream so the agent releases the live session
    res.on("close", () => upstreamAbort.abort());

    try {
      // forward the agent's event-stream bytes verbatim, honouring backpressure
      for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
        if (!res.write(Buffer.from(chunk))) {
          await new Promise<void>((resolve) => res.once("drain", resolve));
        }
      }
    } catch (err) {
      // an aborted upstream (the browser closed) is the normal end of stream, not an error
      if (!upstreamAbort.signal.aborted) logger.warn?.(`[host] cli stream error for ${work.workId}: ${String(err)}`);
    } finally {
      res.end();
    }
  });

  // push one interactive input turn to the owner's cli session (the write half; the SSE GET is the read half)
  router.post("/api/agent/cli/:workId/input", requirePermission("workflow:write"), async (req: Request, res: Response) => {
    const work = await works.get(req.params.workId);
    if (!work || work.userId !== owner(req)) {
      res.status(404).json({ error: "unknown work" });
      return;
    }
    const sessionId = await works.getCliSessionId(work.workId);
    if (!sessionId) {
      res.status(409).json({ error: "cli session not initialized" });
      return;
    }
    const input = String((req.body ?? {}).input ?? "").trim();
    if (!input) {
      res.status(400).json({ error: "input is required" });
      return;
    }
    try {
      await agent.sendInput(sessionId, input);
      res.status(202).json({ accepted: true });
    } catch (err) {
      res.status(502).json({ error: String(err) });
    }
  });

  return router;
}
