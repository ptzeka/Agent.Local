import { Router, type Request, type Response } from "express";
import { OrchestratorEventTypes } from "../../agent/runners/runner-events.js";
import type { ChatMessage } from "../../agent/providers/provider.js";
import { LOGGER } from "../container-tokens.js";
import type { SessionRegistry } from "../session-registry.js";
import type { SseQueue, SseConnection } from "./sse-queue.js";
import type { RuntimeBuilder } from "./runtime-builder.js";

// the client/proxy gets a comment line this often so idle intermediaries don't drop the stream
const HEARTBEAT_MS = 15_000;

// host -> agent SSE RECEIVE: the live READ half of an interactive CLI session. The host opens this per cli
// session and pipes it to the browser. A runtime is built PER connection (resumed off the session), its event
// taxonomy projected to chat frames, and torn down on disconnect. Input arrives separately over /receive and the
// runner injects it into THIS same live runtime. Access = a valid agent:trigger token (upstream middleware) + a
// live session; user→session ownership was already gated host-side, so the agent never learns the user.
export class SseReceiver {
  constructor(
    private readonly sessions: SessionRegistry,
    private readonly sseQueue: SseQueue,
    private readonly builder: RuntimeBuilder,
  ) {}

  routes(): Router {
    const router = Router();
    router.get("/ssereceive/:sessionId", async (req: Request, res: Response) => {
      const logger = req.container.get(LOGGER);
      const sessionId = req.params.sessionId;

      // access to session = a live session + the caller acting FOR the user it is bound to. The service scope
      // (agent:trigger) was already enforced by userContextMiddleware, which only sets userId from a verified OBO
      // token's subject — so it can't be spoofed (no header), and matching it binds the stream to the owner.
      const session = this.sessions.get(sessionId);
      if (!session) {
        res.status(404).json({ error: "unknown session" });
        return;
      }
      const callerUserId = req.userContext.userInfo?.userId;
      if (!session.userId || !callerUserId || callerUserId !== session.userId) {
        res.status(403).json({ error: "forbidden" });
        return;
      }
      // one runtime per connection: a second attach would race two runtimes on the same session store
      if (this.sseQueue.has(sessionId)) {
        res.status(409).json({ error: "session already streaming" });
        return;
      }

      // SSE handshake: stream content-type, no buffering, flush so the client opens the stream immediately
      res.status(200).set({
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.flushHeaders?.();

      // one named SSE frame; data is JSON so the client parses it off the matching addEventListener
      const write = (eventName: string, data: unknown): void => {
        res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      // streamOutput on so the orchestrator emits chat deltas; events stay on this runtime's own bus
      const runtime = await this.builder.build(sessionId, { streamOutput: true });

      // the client may have disconnected during the async build — drain and bail rather than leak a runtime
      if (req.destroyed) {
        await runtime.shutdown({ mode: "drain", timeoutMs: 10_000 }).catch(() => undefined);
        return;
      }

      // project the runtime's events to chat frames the browser appends. Deltas paint the live message; the
      // terminal MESSAGE carries content only when nothing streamed (non-streaming models), else just closes it.
      let streamed = false;
      const unsubscribe = runtime.getEvents().subscribe((event) => {
        if (event.type === OrchestratorEventTypes.MESSAGE_DELTA) {
          streamed = true;
          write("delta", { role: "assistant", content: String(event.payload.delta ?? "") } satisfies ChatMessage);
          return;
        }
        if (event.type === OrchestratorEventTypes.MESSAGE) {
          const content = String(event.payload.content ?? "").trim();
          if (streamed) {
            streamed = false;
            write("end", {});
          } else if (content.length > 0) {
            write("message", { role: "assistant", content } satisfies ChatMessage);
          }
        }
      });

      // turn lifecycle drives the client's busy indicator; the runner's injectInput wakes the loop
      const turnRunner = runtime.startTurnLoop({
        onTurnEvent: (turn) => {
          if (turn.type === "turn-start") write("turn", { status: "start" });
          if (turn.type === "turn-done" && !turnRunner.isBusy) write("turn", { status: "done" });
        },
      });

      const connection: SseConnection = { sessionId, res, runtime };
      this.sseQueue.register(connection);
      write("ready", { sessionId });

      const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), HEARTBEAT_MS);

      // teardown on disconnect: the host aborts this request when the browser tab closes, firing 'close'. Stop the
      // loop, drain the runtime (flush session + close MCP), and release the slot so no live session leaks.
      req.on("close", () => {
        clearInterval(heartbeat);
        unsubscribe();
        this.sseQueue.deregister(sessionId, connection);
        void runtime
          .stopTurnLoop()
          .then(() => runtime.shutdown({ mode: "drain", timeoutMs: 10_000 }))
          .catch((err) => logger.error?.("[agent-server] sse runtime teardown failed", err));
        logger.debug?.(`[agent-server] sse stream closed for session ${sessionId}`);
      });

      logger.debug?.(`[agent-server] sse stream opened for session ${sessionId}`);
    });
    return router;
  }
}
