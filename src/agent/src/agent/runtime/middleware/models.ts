import { ModelRegistry } from "../../registries/index.js";
import { ConfigurationToken, ModelsToken } from "../tokens.js";
import type { IMiddleware, RuntimeContext } from "../types.js";

export interface ModelsMiddlewareParams {
  
}

export class ModelsMiddleware implements IMiddleware 
{
    constructor(private readonly params: ModelsMiddlewareParams = {}) {}
    
    async initialize(ctx: RuntimeContext, next: () => Promise<void>): Promise<void>
    {
        var config = ctx.registry.get(ConfigurationToken);
        var modelsFile = await config.getModelsConfiguration();
        ctx.registry.set(ModelsToken, new ModelRegistry(modelsFile));
        await next();
    }
}