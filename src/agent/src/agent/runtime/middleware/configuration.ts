import { ConfigurationRegistry, ModelsFile } from "../../registries/index.js";
import type { IMiddleware, RuntimeContext } from "../types.js";

export interface ConfigurationMiddlewareParams {
  configPath?: string;
}

export class ConfigurationMiddleware implements IMiddleware 
{
    constructor(private readonly params: ConfigurationMiddlewareParams = {}) {}
    
    async initialize(ctx: RuntimeContext, next: () => Promise<void>): Promise<void>
    {
        ctx.configurationRegistry  = new ConfigurationRegistry(this.params.configPath!);
        await next();
    }
}