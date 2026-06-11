import { ModelRegistry } from "../../registries/index.js";
import type { IMiddleware, RuntimeContext } from "../types.js";

export interface ModelsMiddlewareParams {
  
}

export class ModelsMiddleware implements IMiddleware 
{
    constructor(private readonly params: ModelsMiddlewareParams = {}) {}
    
    async initialize(ctx: RuntimeContext, next: () => Promise<void>): Promise<void>
    {
        var config = ctx.configurationRegistry;
        var modelsFile = await config!.getModelsConfiguration();
        ctx.modelsRegistry = new ModelRegistry(modelsFile);
        await next();
    }
}