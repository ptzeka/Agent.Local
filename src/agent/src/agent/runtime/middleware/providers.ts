import { ProvidersRegistry } from "../../registries/index.js";
import type { IMiddleware, RuntimeContext } from "../types.js";

export interface ProvidersMiddlewareParams {
  
}

export class ProvidersMiddleware implements IMiddleware 
{
    constructor(private readonly params: ProvidersMiddlewareParams = {}) {}
    
    async initialize(ctx: RuntimeContext, next: () => Promise<void>): Promise<void>
    {
        var config = ctx.configurationRegistry;
        var modelsFile = await config!.getModelsConfiguration();
        ctx.providerRegistry = new ProvidersRegistry(modelsFile);
        await ctx.providerRegistry.loadModels();
        await next();
    }
}