import { MetricsRegistry } from "../metrics/metrics-registry.js";
import { MetricsStore } from "../metrics/metrics-store.js";
import { MetricsRegistryToken, SessionToken } from "../tokens.js";
import type { IMiddleware, RuntimeContext } from "../types.js";

// registers the container-owned MetricsRegistry so the runner-pipeline's TurnCounterMiddleware can
// resolve it and fold per-turn usage in, instead of the core loop touching token accounting itself
// the registry seeds from / flushes to the JSONL store keyed by this session's id, so totals survive a resume
export class MetricsRegistryMiddleware implements IMiddleware {
  async initialize(ctx: RuntimeContext, next: () => Promise<void>): Promise<void> {
    const session = ctx.registry.get(SessionToken);
    ctx.registry.set(
      MetricsRegistryToken,
      new MetricsRegistry({
        sessionId: session.sessionId,
        parentSessionId: session.parentSessionId,
        store: new MetricsStore(ctx.db),
      })
    );
    await next();
  }
}
