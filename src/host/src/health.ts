import { Router, type Request, type Response } from "express";
import { connect } from "node:net";
import type { ILogger } from "@agent-local/common";

export interface HealthDeps {
  // host:port of the workflow engine (Zeebe gateway / Temporal frontend). Reachability is a plain TCP connect:
  // a completed handshake means the port is listening = online, regardless of gRPC/HTTP — Temporal has no HTTP
  // health route, so "the socket opened" is the valid online test. Engine-neutral on purpose (the bus is the seam).
  engineAddress: string;
  // where the SEPARATE agent service lives; its own /healthz is the second leg of the composite
  agentBaseUrl: string;
  // mints the host's OWN short-lived service token (client-credentials) so the probe to the agent is authenticated,
  // exactly like the dispatch path — null in unconfigured dev, where the probe falls back to an unauthenticated GET.
  getServiceToken?: () => Promise<string | null>;
  logger: ILogger;
}

// how long to wait on either leg before calling it down — kept short so a hung dependency doesn't stall the
// page-load ping. neither probe ever throws; a timeout or refusal just reads as that leg being false.
const PROBE_TIMEOUT_MS = 2000;
// fallback gateway port when engineAddress carries no port (Zeebe gRPC gateway default)
const DEFAULT_ENGINE_PORT = 26500;

// composite READINESS for the host (/health/ready): ready only when BOTH the workflow engine is reachable AND the
// separate agent service answers its own /healthz. Distinct from the host's /healthz liveness (process is up) —
// a down dependency makes the host unready, not dead. The console pings this once per page load to light the
// "live" chip, so a down dependency (e.g. no workflow server running) surfaces as a 503 instead of a green light.
export function createHealthApi(deps: HealthDeps): Router {
  const router = Router();

  router.get("/health/ready", async (_req: Request, res: Response) => {
    // workflow leg = can we open a socket to the engine port; agent leg = an authenticated /healthz GET.
    const [workflow, agent] = await Promise.all([
      probeReachable(deps.engineAddress, deps.logger),
      probeAgent(deps.agentBaseUrl, deps.getServiceToken, deps.logger),
    ]);
    const ok = workflow && agent;
    res.status(ok ? 200 : 503).json({ status: ok ? "ok" : "degraded", workflow, agent });
  });

  return router;
}

// TCP reachability: a completed handshake proves the engine port is accepting connections (online). Any refusal,
// timeout, or DNS failure reads as down. Protocol-agnostic so it covers Temporal's gRPC frontend (no HTTP health).
function probeReachable(address: string, logger: ILogger): Promise<boolean> {
  return new Promise((resolve) => {
    const { host, port } = parseHostPort(address);
    const socket = connect({ host, port });
    const settle = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS);
    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(false));
    socket.once("error", (err) => {
      logger.debug?.(`[host] engine ${address} reachability probe failed: ${String(err)}`);
      settle(false);
    });
  });
}

// engineAddress is env-shaped ("localhost:26500" or "https://host:7233"); strip any scheme and split host:port
function parseHostPort(address: string): { host: string; port: number } {
  const noScheme = address.replace(/^\w+:\/\//, "");
  const [host, port] = noScheme.split(":");
  return { host: host || "localhost", port: Number(port) || DEFAULT_ENGINE_PORT };
}

// probe the agent service's public /healthz under the host's service identity; any non-2xx, timeout, or connection
// refusal reads as down. The token is best-effort: a fetch failure or unconfigured dev just sends no Authorization.
async function probeAgent(
  baseUrl: string,
  getServiceToken: (() => Promise<string | null>) | undefined,
  logger: ILogger,
): Promise<boolean> {
  try {
    const headers: Record<string, string> = {};
    const token = await getServiceToken?.().catch(() => null);
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(`${baseUrl}/healthz`, { headers, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return res.ok;
  } catch (err) {
    logger.debug?.(`[host] agent /healthz probe failed: ${String(err)}`);
    return false;
  }
}
