import { createProvider, type LLMProvider } from "../providers/index.js";
import { ModelsFile, ModelDefinition } from "./configuration-registry.js";

// providers the agent itself can build a chat client for; other roles (e.g. "reranker") name models
// resolved by a different process (memomcp) and must not be instantiated here
const CHAT_PROVIDERS = new Set(["ollama", "anthropic", "gemini"]);

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
        for (const role of Object.values(this.modelsFile.roles)) {
            this.definitions[role.model] = this.modelsFile.models[role.model];
        };

        for (const [id, def] of Object.entries(this.definitions)) {
            // some roles (e.g. "reranker") name a non-chat model resolved by another process (memomcp);
            // skip providers the agent can't build rather than crash at startup
            if (!CHAT_PROVIDERS.has(def.provider)) continue;
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