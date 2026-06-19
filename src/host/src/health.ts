import { Router, type Request, type Response } from "express";
import type { ILogger } from "@agent-local/common";

export interface HealthDeps {
  // host's Camunda link: the workflow mount's ZeebeClient.connected, read live per request
  zeebeConnected: () => boolean;
  // where the SEPARATE agent service lives; its own /healthz is the second leg of the composite
  agentBaseUrl: string;
  logger: ILogger;
}

// how long to wait on the agent's /healthz before calling it down — kept short so a hung agent doesn't
// stall the page-load ping. the probe never throws; a timeout or refusal just reads as agent:false.
const AGENT_PROBE_TIMEOUT_MS = 2000;

// composite READINESS for the host (/health/ready): ready only when BOTH the Camunda (Zeebe) link is up AND the
// separate agent service answers its own /healthz. Distinct from the host's /healthz liveness (process is up) —
// a down dependency makes the host unready, not dead. The console pings this once per page load to light the
// "live" chip, so a down dependency (e.g. no Camunda server running) surfaces as a 503 instead of a green light.
export function createHealthApi(deps: HealthDeps): Router {
  const router = Router();

  router.get("/health/ready", async (_req: Request, res: Response) => {
    const camunda = deps.zeebeConnected();
    const agent = await probeAgent(deps.agentBaseUrl, deps.logger);
    const ok = camunda && agent;
    res.status(ok ? 200 : 503).json({ status: ok ? "ok" : "degraded", camunda, agent });
  });

  return router;
}

// probe the agent service's public /healthz; any non-2xx, timeout, or connection refusal reads as down
async function probeAgent(baseUrl: string, logger: ILogger): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(AGENT_PROBE_TIMEOUT_MS) });
    return res.ok;
  } catch (err) {
    logger.debug?.(`[host] agent /healthz probe failed: ${String(err)}`);
    return false;
  }
}
