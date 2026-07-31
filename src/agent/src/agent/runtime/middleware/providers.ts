import { ProvidersRegistry } from "../../registries/index.js";
import { ResiliencePolicy } from "../../resilience.js";
import { OrchestratorEventTypes } from "../../runners/runner-events.js";
import { ConfigurationToken, ProvidersToken } from "../tokens.js";
import type { IMiddleware, RuntimeContext } from "../types.js";

export interface ProvidersMiddlewareParams {
  
}

export class ProvidersMiddleware implements IMiddleware 
{
    constructor(private readonly params: ProvidersMiddlewareParams = {}) {}
    
    async initialize(ctx: RuntimeContext, next: () => Promise<void>): Promise<void>
    {
        var config = ctx.registry.get(ConfigurationToken);
        var modelsFile = await config.getModelsConfiguration();
        // resilience is injected, not built into each backend: a new provider case inherits it for free.
        // notices ride the runtime bus because a breaker outlives the turn that tripped it
        const resilience = new ResiliencePolicy("model", {
            onNotice: (notice) =>
                ctx.eventing?.publish(OrchestratorEventTypes.WARNING, { message: notice.message }),
        });
        const providers = new ProvidersRegistry(modelsFile, resilience);
        await providers.loadModels();
        ctx.registry.set(ProvidersToken, providers);
        await next();
    }
}