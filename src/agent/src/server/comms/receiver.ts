import { Router, type Request, type Response } from "express";
import { Eventing } from "@agent-local/common/eventing";
import { LOGGER, SERVER_CONFIG } from "../container-tokens.js";
import { SESSION_HEADER } from "../middleware/session-header.js";
import type { SessionRegistry } from "../session-registry.js";
import { EXECUTION_REQUESTED, type ExecutionRequest, type ExecutionRequested } from "./contract.js";

// host -> agent RECEIVER: the ONLY way in. Pure transport — it terminates the HTTP request, trusts the upstream
// JWT middleware for identity, validates the payload, stamps provenance (source/createdAt), and publishes ONE
// internal event for the runner. It builds no runtime and runs no turn; the answer returns out-of-band, so it
// ACKs 202. Engine vocabulary never reaches here — the body is a neutral ExecutionRequest.
export class HttpReceiver {
  constructor(private readonly sessions: SessionRegistry) {}

  routes(): Router {
    const router = Router();
    router.post("/receive", (req: Request, res: Response) => {
      const logger = req.container.get(LOGGER);
      const config = req.container.get(SERVER_CONFIG);

      // source is only trustworthy off a verified token; a session/stub identity is not a client id. so when
      // enforcement is on, a request that did not present a valid JWT is rejected rather than mis-attributed.
      if (config.authentication.required && !req.userContext.authenticated) {
        res.status(401).json({ error: "unauthorized" });
        return;
      }

      // a session bound to a user (cli) only accepts input from a caller acting FOR that user — the same gate as
      // the SSE stream. userId is set only from a verified OBO token's subject (never a header), so a service
      // token alone can no longer push input into someone's chat. Job sessions (no userId) are untouched.
      const sessionId = req.header(SESSION_HEADER)?.trim() || "anonymous";
      const boundUserId = this.sessions.get(sessionId)?.userId;
      if (boundUserId && req.userContext.userInfo?.userId !== boundUserId) {
        res.status(403).json({ error: "forbidden" });
        return;
      }

      const request = req.body as ExecutionRequest;
      const input = String(request?.input ?? "").trim();
      if (!input || !request?.runId) {
        res.status(400).json({ error: "runId and input are required" });
        return;
      }

      const requested: ExecutionRequested = {
        sessionId,
        runId: request.runId,
        source: req.userContext.userInfo?.serviceId ?? "unknown",
        createdAt: new Date().toISOString(),
        input,
        // only a VERIFIED bearer rides along — a session-capability caller has none, and forwarding an
        // unverified header would let the runner stamp sessions with a forged identity
        ...(req.userContext.authenticated && req.userContext.accessToken
          ? { accessToken: req.userContext.accessToken }
          : {}),
      };
      req.container.get(Eventing).publish(EXECUTION_REQUESTED, { ...requested });
      logger.debug?.(`[agent-server] queued run ${requested.runId} for session ${requested.sessionId}`);
      res.status(202).json({ accepted: true });
    });
    return router;
  }
}
