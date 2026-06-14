import { createProvider, type LLMProvider } from "../providers/index.js";
import { ModelsFile, ModelDefinition } from "./configuration-registry.js";

export class ProvidersRegistry
{
    private definitions = {} as Record<string, ModelDefinition>;
    private providers = {} as Record<string, LLMProvider>;

    constructor(readonly modelsFile: ModelsFile) {}
    
    public loadModels()
    {
        // models.json is the sole source of truth for selection; env carries only secrets/host
        const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
        const geminiApiKey = process.env.GEMINI_API_KEY;
        const ollamaHost = process.env.OLLAMA_HOST ?? "http://localhost:11434";

        // build one provider per role-referenced model only, skipping unused definitions
        for (const [_, def] of Object.entries(this.modelsFile.roles)) {

            var m = this.modelsFile.models[def];
            this.definitions[def] = m;
        };

        for (const [id, def] of Object.entries(this.definitions)) {
            this.providers[id] = createProvider({
                provider: def.provider,
                model: def.model,
                supportsTools: def.supportsTools,
                reasoning: def.reasoning,
                host: ollamaHost,
                apiKey: anthropicApiKey,
                geminiApiKey,
            });
        }
    }
    public getModel(name: string): ModelDefinition
    {
        return this.definitions[name];
    }
    public getProvider(name: string): LLMProvider
    {
        return this.providers[name];
    }
}