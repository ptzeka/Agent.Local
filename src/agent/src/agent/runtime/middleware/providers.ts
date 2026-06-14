import { ProvidersRegistry } from "../../registries/index.js";
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
        const providers = new ProvidersRegistry(modelsFile);
        await providers.loadModels();
        ctx.registry.set(ProvidersToken, providers);
        await next();
    }
}